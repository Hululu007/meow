package core;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.TypeInsnNode;
import org.objectweb.asm.tree.analysis.Analyzer;
import org.objectweb.asm.tree.analysis.BasicInterpreter;
import org.objectweb.asm.tree.analysis.BasicValue;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * 修正 dex2jar（d2j-dex2jar 2.4）的一个翻译缺陷。
 *
 * <p><b>缺陷</b>：dex 里合法的
 * <pre>
 *   new-instance v1, Lmerge/c/e;
 *   invoke-direct {v1}, Ljava/lang/Object;-&gt;&lt;init&gt;()V   // 直接调祖先构造器
 * </pre>
 * 被 d2j 翻成
 * <pre>
 *   new java/lang/Object
 *   dup
 *   invokespecial java/lang/Object.&lt;init&gt;()V
 * </pre>
 * 实例的运行时类型就成了 {@code java.lang.Object}。之后调用 {@code e.f()}、
 * 或把对象塞进 {@code e[]} 时，JVM 直接
 * {@code ArrayStoreException: java.lang.Object}。
 *
 * <p>实测（2026-11-24）：肥猫那版 spider.jar 里 {@code AppDrama} 的
 * detailContent / playerContent / categoryContent 全部中招 ——
 * 表现为 JVM 端「干饭/一碗/再来/行动」能搜不能播，TV 端（直接吃 dex）正常。
 *
 * <p><b>怎么修</b>：d2j 虽然丢了 NEW 的类型，但保留了后续对该对象的
 * {@code invokevirtual/invokeinterface}（owner 就是真实类）。用 ASM 的数据流
 * 给每个 {@code new Object} 打标记，顺着栈/局部变量传播，第一次被当接收者调用时
 * 就记下真实类。
 *
 * <p><b>为什么是"改字节"而不是 ASM 重写 class</b>：实测 ASM 的 ClassNode 往返
 * 会改掉 StackMapTable 的形态（d2j 产物本来就靠 {@code -XX:-BytecodeVerificationRemote}
 * 才过校验，重写后连关校验的宽松模式都可能报
 * {@code VerifyError: Expecting a stackmap frame at branch target N}）。
 * 所以这里只把 Code 里 {@code new} 指令的常量池索引改掉 —— **其余字节一个不动**，
 * stackmap 原样保留。
 *
 * <p><b>约束</b>：只有真实类的直接父类是 {@code java/lang/Object} 时才改 ——
 * 这样 {@code new C} 配原来的 {@code Object.<init>} 仍是合法的 super 调用。
 *
 * <p>修补是**尽力而为**：任何异常都不抛出，原 jar 保持不变，转换流程继续。
 */
public final class DexJvmFix {

    private DexJvmFix() {
    }

    /** 一次修补的统计，给调用方打日志用。 */
    public static final class Result {
        public int classes;
        public int sites;
        public int unresolved;

        @Override
        public String toString() {
            return "classes=" + classes + " sites=" + sites + " unresolved=" + unresolved;
        }
    }

    /** 原地修补一个 d2j 转换出来的 class jar。返回 null = jar 不可读/不可写。 */
    public static Result patchJar(File jar) {
        if (jar == null || !jar.isFile() || jar.length() == 0) return null;
        Result result = new Result();
        try {
            Map<String, byte[]> entries = readAll(jar);
            Map<String, String> superOf = new HashMap<>();
            for (Map.Entry<String, byte[]> e : entries.entrySet()) {
                if (!e.getKey().endsWith(".class")) continue;
                try {
                    ClassReader cr = new ClassReader(e.getValue());
                    superOf.put(cr.getClassName(), cr.getSuperName());
                } catch (Throwable ignored) {
                }
            }
            List<String> changed = new ArrayList<>();
            for (Map.Entry<String, byte[]> e : entries.entrySet()) {
                String name = e.getKey();
                if (!name.endsWith(".class") || name.startsWith("META-INF/")) continue;
                try {
                    byte[] fixed = patchClass(e.getValue(), superOf, result);
                    if (fixed != null) {
                        changed.add(name);
                        entries.put(name, fixed);
                    }
                } catch (Throwable ignored) {
                    // 单类失败不影响整包
                }
            }
            if (changed.isEmpty()) return result;

            Path tmp = Files.createTempFile(jar.getParentFile().toPath(), jar.getName() + ".", ".fix");
            try {
                writeAll(entries, tmp.toFile());
                try {
                    Files.move(tmp, jar.toPath(), StandardCopyOption.REPLACE_EXISTING);
                } catch (Exception moveFail) {
                    Files.deleteIfExists(tmp);
                    return null;
                }
            } finally {
                Files.deleteIfExists(tmp);
            }
            return result;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 修一个 class；没改动返回 null。 */
    private static byte[] patchClass(byte[] bytes, Map<String, String> superOf, Result result) {
        ClassReader cr = new ClassReader(bytes);
        ClassNode cn = new ClassNode();
        cr.accept(cn, 0);

        ClassFile cf;
        try {
            cf = new ClassFile(bytes);
        } catch (Throwable t) {
            return null;
        }

        boolean changed = false;
        for (MethodNode mn : cn.methods) {
            if (mn.instructions == null || mn.instructions.size() == 0) continue;

            // 1) 候选点位（NEW java/lang/Object + DUP + Object.<init>）与真实类推断
            List<TypeInsnNode> hits = new ArrayList<>();
            for (AbstractInsnNode ins = mn.instructions.getFirst(); ins != null; ins = ins.getNext()) {
                if (!(ins instanceof TypeInsnNode)) continue;
                TypeInsnNode tn = (TypeInsnNode) ins;
                if (tn.getOpcode() != Opcodes.NEW || !"java/lang/Object".equals(tn.desc)) continue;
                AbstractInsnNode n1 = nextReal(ins.getNext());
                AbstractInsnNode n2 = n1 == null ? null : nextReal(n1.getNext());
                if (n1 != null && n1.getOpcode() == Opcodes.DUP && n2 instanceof MethodInsnNode) {
                    MethodInsnNode mi = (MethodInsnNode) n2;
                    if (mi.getOpcode() == Opcodes.INVOKESPECIAL
                            && "java/lang/Object".equals(mi.owner)
                            && "<init>".equals(mi.name)
                            && "()V".equals(mi.desc)) {
                        hits.add(tn);
                    }
                }
            }
            if (hits.isEmpty()) continue;

            Map<Integer, String> byIndex = infer(cn.name, mn);
            List<String> targets = new ArrayList<>();
            boolean anyTarget = false;
            for (TypeInsnNode tn : hits) {
                String real = byIndex.get(mn.instructions.indexOf(tn));
                String sup = real == null ? null : superOf.get(real);
                if (real != null && "java/lang/Object".equals(sup)) {
                    targets.add(real);
                    anyTarget = true;
                } else {
                    targets.add(null);
                    result.unresolved++;
                }
            }
            if (!anyTarget) continue;

            // 2) 字节级定位：按顺序把 new java/lang/Object 的常量池索引换掉
            ClassFile.MethodCode code = cf.code(mn.name, mn.desc);
            if (code == null) {
                result.unresolved += targets.size();
                continue;
            }
            List<Integer> newOffsets = new ArrayList<>();
            cf.collectNewObjectOffsets(code, newOffsets);
            if (newOffsets.size() != targets.size()) {
                // 字节视角与 ASM 视角对不上：整方法不动，避免错位改坏
                result.unresolved += targets.size();
                continue;
            }
            for (int i = 0; i < newOffsets.size(); i++) {
                String real = targets.get(i);
                if (real == null) continue;
                int cpIndex = cf.classCpIndex(real);
                if (cpIndex <= 0) {
                    result.unresolved++;
                    continue;
                }
                int off = newOffsets.get(i);
                cf.bytes[off + 1] = (byte) (cpIndex >> 8);
                cf.bytes[off + 2] = (byte) cpIndex;
                result.sites++;
                changed = true;
            }
        }
        if (!changed) return null;
        result.classes++;
        return cf.bytes;
    }

    // ---------------------------------------------------------------- 数据流推断

    /**
     * 数据流推断：给每个 {@code NEW java/lang/Object} 找真实类。
     * 自定义 Interpreter 给 NEW 打 "未初始化(指令下标)" 值，它能被
     * DUP/ASTORE/ALOAD 原样搬运；第一次作为接收者传给 invokevirtual/interface
     * 时，owner 就是真实类。
     */
    private static Map<Integer, String> infer(String owner, MethodNode mn) {
        Map<Integer, String> out = new HashMap<>();
        try {
            new Analyzer<>(new Interp(mn, out)).analyze(owner, mn);
        } catch (Throwable ignored) {
            // 分析失败就用已经收集到的部分
        }
        return out;
    }

    private static final class Uninit extends BasicValue {
        final int offset;

        Uninit(int offset) {
            super(Type.getObjectType("java/lang/Object"));
            this.offset = offset;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Uninit && ((Uninit) o).offset == offset;
        }

        @Override
        public int hashCode() {
            return offset * 31 + 7;
        }
    }

    private static final class Interp extends BasicInterpreter {
        private final Map<Integer, String> out;
        private final MethodNode method;

        Interp(MethodNode method, Map<Integer, String> out) {
            super(Opcodes.ASM9);
            this.method = method;
            this.out = out;
        }

        private BasicValue mark(AbstractInsnNode insn) {
            if (!(insn instanceof TypeInsnNode)) return null;
            TypeInsnNode tn = (TypeInsnNode) insn;
            if (tn.getOpcode() != Opcodes.NEW || !"java/lang/Object".equals(tn.desc)) return null;
            return new Uninit(method.instructions.indexOf(tn));
        }

        @Override
        public BasicValue newOperation(AbstractInsnNode insn)
                throws org.objectweb.asm.tree.analysis.AnalyzerException {
            BasicValue marked = mark(insn);
            return marked != null ? marked : super.newOperation(insn);
        }

        @Override
        public BasicValue unaryOperation(AbstractInsnNode insn, BasicValue value)
                throws org.objectweb.asm.tree.analysis.AnalyzerException {
            BasicValue r = super.unaryOperation(insn, value);
            if (value instanceof Uninit && r == value) return BasicValue.REFERENCE_VALUE;
            return r;
        }

        @Override
        public BasicValue naryOperation(AbstractInsnNode insn, List<? extends BasicValue> values)
                throws org.objectweb.asm.tree.analysis.AnalyzerException {
            if (insn instanceof MethodInsnNode && !values.isEmpty()) {
                MethodInsnNode mi = (MethodInsnNode) insn;
                boolean instanceCall = mi.getOpcode() == Opcodes.INVOKEVIRTUAL
                        || mi.getOpcode() == Opcodes.INVOKEINTERFACE
                        || mi.getOpcode() == Opcodes.INVOKESPECIAL;
                if (instanceCall) {
                    BasicValue recv = values.get(0);
                    if (recv instanceof Uninit && !"java/lang/Object".equals(mi.owner)
                            && !"<init>".equals(mi.name)) {
                        out.put(((Uninit) recv).offset, mi.owner);
                    }
                }
            }
            return super.naryOperation(insn, values);
        }

        @Override
        public BasicValue merge(BasicValue v1, BasicValue v2) {
            if (v1 instanceof Uninit && v2 instanceof Uninit) {
                return ((Uninit) v1).offset == ((Uninit) v2).offset ? v1 : BasicValue.REFERENCE_VALUE;
            }
            if (v1 instanceof Uninit || v2 instanceof Uninit) return BasicValue.REFERENCE_VALUE;
            return super.merge(v1, v2);
        }
    }

    // ---------------------------------------------------------------- 极简 class 文件解析（只读 Code + 常量池）

    /** 只解析到"能定位 Code 字节与常量池 Class 项"的程度。 */
    private static final class ClassFile {
        byte[] bytes;
        int cpCount;
        int[] tag;
        int[] a;
        String[] utf8;
        final Map<String, Integer> classIndexByName = new HashMap<>();
        final Map<String, MethodCode> codeByNameDesc = new HashMap<>();

        static final class MethodCode {
            String name, desc;
            int codeOffset;
            int codeLength;
        }

        ClassFile(byte[] b) {
            this.bytes = b;
            Cursor c = new Cursor();
            if (u4(c) != 0xCAFEBABEL) throw new IllegalStateException("not class");
            u2(c);
            u2(c);
            cpCount = u2(c);
            tag = new int[cpCount];
            a = new int[cpCount];
            utf8 = new String[cpCount];
            for (int i = 1; i < cpCount; i++) {
                int t = u1(c);
                tag[i] = t;
                switch (t) {
                    case 1: {
                        int len = u2(c);
                        utf8[i] = new String(bytes, c.pos, len, StandardCharsets.UTF_8);
                        a[i] = c.pos;
                        c.pos += len;
                        break;
                    }
                    case 7:
                        a[i] = u2(c);
                        break;
                    case 8:
                    case 16:
                    case 19:
                    case 20:
                        u2(c);
                        break;
                    case 15:
                        u1(c);
                        u2(c);
                        break;
                    case 3:
                    case 4:
                    case 9:
                    case 10:
                    case 11:
                    case 12:
                    case 17:
                    case 18:
                        u4(c);
                        break;
                    case 5:
                    case 6:
                        u4(c);
                        u4(c);
                        i++; // long/double 占两个槽
                        break;
                    default:
                        throw new IllegalStateException("cp tag " + t);
                }
            }
            for (int i = 1; i < cpCount; i++) {
                if (tag[i] == 7) {
                    String n = utf8[a[i]];
                    if (n != null) classIndexByName.putIfAbsent(n, i);
                }
            }
            u2(c); // access
            u2(c); // this
            u2(c); // super
            int ifCount = u2(c);
            c.pos += ifCount * 2;
            skipMembers(c);
            int mCount = u2(c);
            for (int i = 0; i < mCount; i++) {
                u2(c); // flags
                int nameIdx = u2(c);
                int descIdx = u2(c);
                String name = utf8[nameIdx];
                String desc = utf8[descIdx];
                int attrCount = u2(c);
                MethodCode mc = null;
                for (int k = 0; k < attrCount; k++) {
                    int an = u2(c);
                    int alen = (int) u4(c);
                    int start = c.pos;
                    if ("Code".equals(utf8[an])) {
                        u2(c); // max_stack
                        u2(c); // max_locals
                        int codeLen = (int) u4(c);
                        mc = new MethodCode();
                        mc.name = name;
                        mc.desc = desc;
                        mc.codeOffset = c.pos;
                        mc.codeLength = codeLen;
                    }
                    c.pos = start + alen;
                }
                if (mc != null && name != null && desc != null) codeByNameDesc.put(name + desc, mc);
            }
        }

        MethodCode code(String name, String desc) {
            return codeByNameDesc.get(name + desc);
        }

        int classCpIndex(String internalName) {
            Integer v = classIndexByName.get(internalName);
            return v == null ? -1 : v;
        }

        /** 顺序扫出该方法的 {@code new java/lang/Object} 指令偏移。 */
        void collectNewObjectOffsets(MethodCode mc, List<Integer> out) {
            int end = mc.codeOffset + mc.codeLength;
            int p = mc.codeOffset;
            while (p < end) {
                int op = bytes[p] & 0xFF;
                if (op == 0xBB) {
                    int idx = ((bytes[p + 1] & 0xFF) << 8) | (bytes[p + 2] & 0xFF);
                    if (idx > 0 && idx < cpCount && tag[idx] == 7
                            && "java/lang/Object".equals(utf8[a[idx]])) {
                        out.add(p);
                    }
                    p += 3;
                    continue;
                }
                int len = insnLength(p, mc.codeOffset);
                p += len <= 0 ? 1 : len;
            }
        }

        private int insnLength(int p, int codeStart) {
            int op = bytes[p] & 0xFF;
            if (op <= 0x0F) return 1;
            switch (op) {
                case 0x10: return 2;
                case 0x11: return 3;
                case 0x12: return 2;
                case 0x13:
                case 0x14: return 3;
                case 0x15:
                case 0x16:
                case 0x17:
                case 0x18:
                case 0x19: return 2;
                case 0x36:
                case 0x37:
                case 0x38:
                case 0x39:
                case 0x3A: return 2;
                case 0x84: return 3;
                case 0x99: case 0x9A: case 0x9B: case 0x9C: case 0x9D: case 0x9E:
                case 0x9F: case 0xA0: case 0xA1: case 0xA2: case 0xA3: case 0xA4:
                case 0xA5: case 0xA6: case 0xA7: case 0xA8: return 3;
                case 0xA9: return 2;
                case 0xAA: {
                    int q = align4(p + 1, codeStart);
                    int low = i4(q + 4);
                    int high = i4(q + 8);
                    return (q - p) + 12 + (high - low + 1) * 4;
                }
                case 0xAB: {
                    int q = align4(p + 1, codeStart);
                    int npairs = i4(q + 4);
                    return (q - p) + 8 + npairs * 8;
                }
                case 0xB2: case 0xB3: case 0xB4: case 0xB5:
                case 0xB6: case 0xB7: case 0xB8: return 3;
                case 0xB9:
                case 0xBA: return 5;
                case 0xBB: return 3;
                case 0xBC: return 2;
                case 0xBD: return 3;
                case 0xC0:
                case 0xC1: return 3;
                case 0xC4: {
                    int next = bytes[p + 1] & 0xFF;
                    return next == 0x84 ? 6 : 4;
                }
                case 0xC5: return 4;
                case 0xC6:
                case 0xC7: return 3;
                case 0xC8:
                case 0xC9: return 5;
                default:
                    return 1;
            }
        }

        private static int align4(int q, int start) {
            int rel = q - start;
            int pad = (4 - (rel & 3)) & 3;
            return q + pad;
        }

        private int i4(int p) {
            return ((bytes[p] & 0xFF) << 24) | ((bytes[p + 1] & 0xFF) << 16)
                    | ((bytes[p + 2] & 0xFF) << 8) | (bytes[p + 3] & 0xFF);
        }

        private final class Cursor {
            int pos;
        }

        private int u1(Cursor c) {
            return bytes[c.pos++] & 0xFF;
        }

        private int u2(Cursor c) {
            int v = ((bytes[c.pos] & 0xFF) << 8) | (bytes[c.pos + 1] & 0xFF);
            c.pos += 2;
            return v;
        }

        private long u4(Cursor c) {
            long v = ((long) (bytes[c.pos] & 0xFF) << 24) | ((bytes[c.pos + 1] & 0xFF) << 16)
                    | ((bytes[c.pos + 2] & 0xFF) << 8) | (bytes[c.pos + 3] & 0xFF);
            c.pos += 4;
            return v;
        }

        private void skipMembers(Cursor c) {
            int n = u2(c);
            for (int i = 0; i < n; i++) {
                u2(c);
                u2(c);
                u2(c);
                int attrs = u2(c);
                for (int k = 0; k < attrs; k++) {
                    u2(c);
                    int len = (int) u4(c);
                    c.pos += len;
                }
            }
        }
    }

    // ---------------------------------------------------------------- 小工具

    private static AbstractInsnNode nextReal(AbstractInsnNode n) {
        while (n != null && n.getOpcode() < 0) n = n.getNext();
        return n;
    }

    private static Map<String, byte[]> readAll(File jar) throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        try (ZipFile zf = new ZipFile(jar)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                try (InputStream in = zf.getInputStream(e)) {
                    entries.put(e.getName(), readFully(in));
                }
            }
        }
        return entries;
    }

    private static byte[] readFully(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private static void writeAll(Map<String, byte[]> entries, File out) throws Exception {
        try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(out.toPath()))) {
            for (Map.Entry<String, byte[]> e : entries.entrySet()) {
                ZipEntry ze = new ZipEntry(e.getKey());
                ze.setTime(0);
                zos.putNextEntry(ze);
                zos.write(e.getValue());
                zos.closeEntry();
            }
        }
    }
}
