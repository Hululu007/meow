package jvm;

import com.googlecode.d2j.Method;
import com.googlecode.d2j.dex.Dex2jar;
import com.googlecode.d2j.node.DexClassNode;
import com.googlecode.d2j.node.DexFileNode;
import com.googlecode.d2j.node.DexMethodNode;
import com.googlecode.d2j.node.insn.DexStmtNode;
import com.googlecode.d2j.node.insn.MethodStmtNode;
import com.googlecode.d2j.node.insn.TypeStmtNode;
import com.googlecode.d2j.reader.Op;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.InsnNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.TypeInsnNode;
import org.objectweb.asm.tree.VarInsnNode;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;

/**
 * 把壳解出来的 dex 转成 JVM 可加载的 class jar。
 *
 * <p>这个 payload 被壳做过「JVM 不合法、ART 宽容」的处理：
 * <ul>
 *   <li>很多类没有 &lt;init&gt;，代码却直接 new 出来用（ART 允许，JVM 不允许）；</li>
 *   <li>new-instance 后调用的是父类构造器；</li>
 *   <li>new-instance 的类型被壳抹成 java/lang/Object。</li>
 * </ul>
 * 所以按 dex 里的真实 new-instance 类型（构造器签名匹配）+ 补默认构造 +
 * 重算栈帧，产出一份普通 class jar。
 *
 * <p>这套修复只依赖 dex2jar 的 reader/translator 和 ASM，不依赖 Python。
 */
public final class GuardRepair {

    private GuardRepair() {
    }

    /** 解密出的 payload（zip + classes.dex）→ 最终 class jar。 */
    public static void convertAndRepair(File payloadZip, File outJar) throws Exception {
        Dex2jar d2j = Dex2jar.from(payloadZip);
        DexFileNode node = new DexFileNode();
        d2j.getReader().accept(node);
        Map<String, List<Entry>> map = buildMap(node);
        System.out.println("[GuardRepair] dex classes=" + node.clzs.size() + " methodsWithNew=" + map.size());

        File classesJar = new File(outJar.getAbsolutePath() + ".classes");
        try {
            d2j.reUseReg(true).skipDebug(true).to(classesJar.toPath());
            repair(classesJar, map, outJar);
        } finally {
            try {
                Files.deleteIfExists(classesJar.toPath());
            } catch (Throwable ignored) {
            }
        }
    }

    // ---------------------------------------------------------------- dex 映射

    static final class Entry {
        String type;   // Lcom/foo/Bar;
        String owner;  // ctor owner descriptor
        String desc;   // ctor descriptor
        int reg;
    }

    static Map<String, List<Entry>> buildMap(DexFileNode node) {
        Map<String, List<Entry>> out = new HashMap<>();
        for (DexClassNode c : node.clzs) {
            if (c.methods == null) continue;
            for (DexMethodNode m : c.methods) {
                if (m.codeNode == null || m.codeNode.stmts == null) continue;
                List<Entry> list = new ArrayList<>();
                Map<Integer, Entry> byReg = new HashMap<>();
                for (DexStmtNode st : m.codeNode.stmts) {
                    if (st.op == Op.NEW_INSTANCE && st instanceof TypeStmtNode) {
                        TypeStmtNode t = (TypeStmtNode) st;
                        Entry e = new Entry();
                        e.type = t.type;
                        e.reg = t.a;
                        list.add(e);
                        byReg.put(t.a, e);
                    } else if (st.op == Op.INVOKE_DIRECT && st instanceof MethodStmtNode) {
                        MethodStmtNode ms = (MethodStmtNode) st;
                        Method method = ms.method;
                        if (method == null || !"<init>".equals(method.getName()) || ms.args.length == 0) continue;
                        Entry e = byReg.remove(ms.args[0]);
                        if (e != null) {
                            e.owner = method.getOwner();
                            e.desc = method.getDesc();
                        }
                    }
                }
                if (!list.isEmpty()) {
                    out.put(c.className + "->" + m.method.getName() + m.method.getDesc(), list);
                }
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- class 修复

    static final Map<String, ClassNode> NODES = new HashMap<>();
    static final Map<String, Set<String>> CTORS = new HashMap<>();
    static final Map<String, Set<String>> ADD = new LinkedHashMap<>();
    static final Set<String> TARGETS = new HashSet<>();
    static final String OBJ = "java/lang/Object";

    static void repair(File classesJar, Map<String, List<Entry>> map, File outJar) throws Exception {
        LinkedHashMap<String, byte[]> raw = new LinkedHashMap<>();
        try (JarFile jar = new JarFile(classesJar)) {
            Enumeration<JarEntry> e = jar.entries();
            while (e.hasMoreElements()) {
                JarEntry je = e.nextElement();
                if (je.isDirectory()) continue;
                byte[] b = readAll(jar.getInputStream(je));
                raw.put(je.getName(), b);
                if (je.getName().endsWith(".class")) {
                    ClassNode cn = new ClassNode();
                    new ClassReader(b).accept(cn, 0);
                    NODES.put(cn.name, cn);
                    Set<String> s = new HashSet<>();
                    for (MethodNode m : cn.methods) if ("<init>".equals(m.name)) s.add(m.desc);
                    CTORS.put(cn.name, s);
                }
            }
        }

        for (List<Entry> list : map.values()) {
            for (Entry e : list) {
                if (e.type == null || !e.type.startsWith("L") || !e.type.endsWith(";")) continue;
                String cls = e.type.substring(1, e.type.length() - 1);
                TARGETS.add(cls);
            }
        }
        // 先按 dex 的构造签名补；再全量扫 class 文件兜底（含父类构造调用）
        for (List<Entry> list : map.values()) {
            for (Entry e : list) {
                if (e.type == null || e.desc == null) continue;
                String cls = e.type.substring(1, e.type.length() - 1);
                ensureCtor(cls, e.desc, 0);
            }
        }
        preScanCtors();

        // UI-only 方法：dex2jar 的寄存器复用会翻出 JVM 校验不过的局部变量类型；
        // 服务器端没有 Activity，直接置空。
        neutraliseUiMethods();

        for (ClassNode cn : NODES.values()) {
            boolean iface = (cn.access & Opcodes.ACC_INTERFACE) != 0;
            if (!iface && TARGETS.contains(cn.name) && (cn.access & Opcodes.ACC_ABSTRACT) != 0) {
                cn.access &= ~Opcodes.ACC_ABSTRACT;
                for (MethodNode m : cn.methods) {
                    if ((m.access & Opcodes.ACC_ABSTRACT) != 0) {
                        m.access &= ~Opcodes.ACC_ABSTRACT;
                        fillDefault(m);
                    }
                }
            }
            for (MethodNode m : cn.methods) {
                String key = "L" + cn.name + ";->" + m.name + m.desc;
                List<Entry> dex = map.get(key);
                if (dex != null) transform(m, dex);
                fixCtors(m);
                fixSuperInit(cn, m);
            }
        }
        // 构造补齐放到全部改写之后（fixSuperInit 可能给已遍历过的父类新增构造）
        for (ClassNode cn : NODES.values()) {
            Set<String> adds = ADD.get(cn.name);
            if (adds != null) {
                for (String d : adds) if (good(d)) addCtor(cn, d);
            }
        }

        try (JarOutputStream jos = new JarOutputStream(new FileOutputStream(outJar))) {
            for (Map.Entry<String, byte[]> en : raw.entrySet()) {
                byte[] b = en.getValue();
                if (en.getKey().endsWith(".class")) {
                    ClassNode cn = NODES.get(en.getKey().substring(0, en.getKey().length() - 6));
                    b = writeClass(cn);
                }
                jos.putNextEntry(new JarEntry(en.getKey()));
                jos.write(b);
                jos.closeEntry();
            }
        }
        int n = 0;
        for (Set<String> s : ADD.values()) n += s.size();
        System.out.println("[GuardRepair] targets=" + TARGETS.size() + " ctorsAdd=" + n + " -> " + outJar);
    }

    static byte[] writeClass(ClassNode cn) {
        try {
            ClassWriter cw = new ClassWriter(ClassWriter.COMPUTE_FRAMES) {
                protected String getCommonSuperClass(String a, String b) {
                    return common(a, b);
                }
            };
            cn.accept(cw);
            return cw.toByteArray();
        } catch (Throwable t) {
            System.out.println("[GuardRepair] FRAMEFAIL " + cn.name + " " + t);
            ClassWriter cw = new ClassWriter(ClassWriter.COMPUTE_MAXS);
            cn.accept(cw);
            return cw.toByteArray();
        }
    }

    static void neutraliseUiMethods() {
        ClassNode ui = NODES.get("com/github/catvod/spider/merge/y0/e");
        if (ui == null) return;
        for (MethodNode m : ui.methods) {
            if ("L0".equals(m.name) && "(Landroid/widget/TextView;Landroid/widget/TextView;Z)V".equals(m.desc)) {
                fillDefault(m);
            }
        }
    }

    static void preScanCtors() {
        for (ClassNode cn : NODES.values()) {
            for (MethodNode m : cn.methods) {
                ArrayDeque<String> news = new ArrayDeque<>();
                for (AbstractInsnNode x : m.instructions.toArray()) {
                    if (x instanceof TypeInsnNode && x.getOpcode() == Opcodes.NEW) {
                        news.push(((TypeInsnNode) x).desc);
                    } else if (x instanceof MethodInsnNode && x.getOpcode() == Opcodes.INVOKESPECIAL
                            && "<init>".equals(((MethodInsnNode) x).name)) {
                        if (news.isEmpty()) continue;
                        String t = news.pop();
                        if (!OBJ.equals(t)) ensureCtor(t, ((MethodInsnNode) x).desc, 0);
                    }
                }
                while (!news.isEmpty()) {
                    String t = news.pop();
                    if (!OBJ.equals(t)) ensureCtor(t, "()V", 0);
                }
                if ("<init>".equals(m.name)) {
                    for (AbstractInsnNode x : m.instructions.toArray()) {
                        if (x instanceof MethodInsnNode && x.getOpcode() == Opcodes.INVOKESPECIAL
                                && "<init>".equals(((MethodInsnNode) x).name)) {
                            MethodInsnNode mi = (MethodInsnNode) x;
                            if (!OBJ.equals(mi.owner)) ensureCtor(mi.owner, mi.desc, 0);
                        }
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- 逐方法

    static void transform(MethodNode mn, List<Entry> dex) {
        AbstractInsnNode[] ins = mn.instructions.toArray();
        boolean[] used = new boolean[dex.size()];
        for (int i = 0; i < ins.length; i++) {
            if (!(ins[i] instanceof TypeInsnNode)) continue;
            TypeInsnNode tin = (TypeInsnNode) ins[i];
            if (tin.getOpcode() != Opcodes.NEW) continue;
            MethodInsnNode init = null;
            int depth = 0;
            for (int j = i + 1; j < ins.length; j++) {
                AbstractInsnNode x = ins[j];
                if (x.getOpcode() == Opcodes.NEW) depth++;
                else if (x instanceof MethodInsnNode && x.getOpcode() == Opcodes.INVOKESPECIAL
                        && "<init>".equals(((MethodInsnNode) x).name)) {
                    if (depth == 0) {
                        init = (MethodInsnNode) x;
                        break;
                    }
                    depth--;
                }
            }
            String oldType = tin.desc;
            String ctorOwner = init == null ? "" : init.owner;
            String ctorDesc = init == null ? "" : init.desc;
            int pick = pick(dex, used, oldType, ctorOwner, ctorDesc);
            if (pick < 0) continue;
            used[pick] = true;
            Entry e = dex.get(pick);
            String t = internal(e.type);
            if (t.isEmpty()) continue;
            tin.desc = t;
            if (init != null) init.owner = t;
            ensureCtor(t, good(e.desc) ? e.desc : (good(ctorDesc) ? ctorDesc : "()V"), 0);
        }
    }

    static int pick(List<Entry> dex, boolean[] used, String oldType, String ctorOwner, String ctorDesc) {
        for (int i = 0; i < dex.size(); i++) {
            if (used[i]) continue;
            Entry e = dex.get(i);
            String t = internal(e.type);
            if (t.isEmpty()) continue;
            boolean typeOk = t.equals(oldType) || (!OBJ.equals(oldType) && isSubtype(t, oldType));
            if (!typeOk) continue;
            if (!ctorOwner.isEmpty() && ("L" + ctorOwner + ";").equals(e.owner) && ctorDesc.equals(e.desc)) return i;
        }
        if (OBJ.equals(oldType)) {
            for (int i = 0; i < dex.size(); i++) {
                if (used[i]) continue;
                if (OBJ.equals(internal(dex.get(i).type))) return i;
            }
        }
        int fallback = -1;
        for (int i = 0; i < dex.size(); i++) {
            if (used[i]) continue;
            Entry e = dex.get(i);
            String t = internal(e.type);
            if (t.isEmpty() || OBJ.equals(t)) continue;
            boolean typeOk = OBJ.equals(oldType) || t.equals(oldType) || isSubtype(t, oldType);
            if (typeOk && fallback < 0) fallback = i;
        }
        return fallback;
    }

    static void fixCtors(MethodNode mn) {
        ArrayDeque<TypeInsnNode> news = new ArrayDeque<>();
        for (AbstractInsnNode x : mn.instructions.toArray()) {
            if (x instanceof TypeInsnNode && x.getOpcode() == Opcodes.NEW) {
                news.push((TypeInsnNode) x);
            } else if (x instanceof MethodInsnNode && x.getOpcode() == Opcodes.INVOKESPECIAL
                    && "<init>".equals(((MethodInsnNode) x).name)) {
                if (news.isEmpty()) continue;
                TypeInsnNode tin = news.pop();
                MethodInsnNode init = (MethodInsnNode) x;
                String t = tin.desc;
                if (OBJ.equals(t) || t.equals(init.owner)) continue;
                if (!OBJ.equals(init.owner) && !isSubtype(t, init.owner)) continue;
                if (ensureCtor(t, init.desc, 0)) init.owner = t;
            }
        }
        while (!news.isEmpty()) {
            TypeInsnNode tin = news.pop();
            String t = tin.desc;
            if (OBJ.equals(t)) continue;
            if (ensureCtor(t, "()V", 0)) {
                mn.instructions.insert(tin, new MethodInsnNode(Opcodes.INVOKESPECIAL, t, "<init>", "()V", false));
                mn.instructions.insert(tin, new InsnNode(Opcodes.DUP));
            }
        }
    }

    static void fixSuperInit(ClassNode cn, MethodNode m) {
        if (!"<init>".equals(m.name)) return;
        String direct = cn.superName == null ? OBJ : cn.superName;
        for (AbstractInsnNode x : m.instructions.toArray()) {
            if (!(x instanceof MethodInsnNode) || x.getOpcode() != Opcodes.INVOKESPECIAL) continue;
            MethodInsnNode mi = (MethodInsnNode) x;
            if (!"<init>".equals(mi.name)) continue;
            if (mi.owner.equals(cn.name) || mi.owner.equals(direct)) continue;
            if (isSubtype(direct, mi.owner) && ensureCtor(direct, mi.desc, 0)) mi.owner = direct;
        }
    }

    // ---------------------------------------------------------------- 构造补齐

    static boolean ensureCtor(String cls, String desc, int depth) {
        if (!good(desc) || depth > 32) return false;
        ClassNode cn = NODES.get(cls);
        if (cn == null) return true;
        if ((cn.access & Opcodes.ACC_INTERFACE) != 0) return false;
        if ("()V".equals(desc) && isEnum(cls)) return false;
        if (CTORS.get(cls).contains(desc)) return true;
        String sup = cn.superName == null ? OBJ : cn.superName;
        if (!ensureCtor(sup, desc, depth + 1)) return false;
        ADD.computeIfAbsent(cls, k -> new LinkedHashSet<>()).add(desc);
        CTORS.get(cls).add(desc);
        return true;
    }

    static void addCtor(ClassNode cn, String desc) {
        MethodNode m = new MethodNode(Opcodes.ACC_PUBLIC, "<init>", desc, null, null);
        InsnList il = m.instructions;
        il.add(new VarInsnNode(Opcodes.ALOAD, 0));
        int local = 1;
        for (Type at : Type.getArgumentTypes(desc)) {
            il.add(new VarInsnNode(at.getOpcode(Opcodes.ILOAD), local));
            local += at.getSize();
        }
        il.add(new MethodInsnNode(Opcodes.INVOKESPECIAL, cn.superName == null ? OBJ : cn.superName, "<init>", desc, false));
        il.add(new InsnNode(Opcodes.RETURN));
        cn.methods.add(m);
    }

    static void fillDefault(MethodNode m) {
        m.instructions.clear();
        if (m.tryCatchBlocks != null) m.tryCatchBlocks.clear();
        if (m.localVariables != null) m.localVariables.clear();
        Type r = Type.getReturnType(m.desc);
        switch (r.getSort()) {
            case Type.VOID:
                m.instructions.add(new InsnNode(Opcodes.RETURN));
                break;
            case Type.BOOLEAN:
            case Type.CHAR:
            case Type.BYTE:
            case Type.SHORT:
            case Type.INT:
                m.instructions.add(new InsnNode(Opcodes.ICONST_0));
                m.instructions.add(new InsnNode(Opcodes.IRETURN));
                break;
            case Type.LONG:
                m.instructions.add(new InsnNode(Opcodes.LCONST_0));
                m.instructions.add(new InsnNode(Opcodes.LRETURN));
                break;
            case Type.FLOAT:
                m.instructions.add(new InsnNode(Opcodes.FCONST_0));
                m.instructions.add(new InsnNode(Opcodes.FRETURN));
                break;
            case Type.DOUBLE:
                m.instructions.add(new InsnNode(Opcodes.DCONST_0));
                m.instructions.add(new InsnNode(Opcodes.DRETURN));
                break;
            default:
                m.instructions.add(new InsnNode(Opcodes.ACONST_NULL));
                m.instructions.add(new InsnNode(Opcodes.ARETURN));
        }
    }

    // ---------------------------------------------------------------- 类型

    static boolean good(String d) {
        return d != null && !d.isEmpty() && !"null".equals(d) && d.startsWith("(");
    }

    static String internal(String d) {
        if (d != null && d.startsWith("L") && d.endsWith(";")) return d.substring(1, d.length() - 1);
        return d == null ? "" : d;
    }

    static boolean isEnum(String cls) {
        String cur = cls;
        for (int i = 0; i < 32 && cur != null; i++) {
            if ("java/lang/Enum".equals(cur)) return true;
            ClassNode n = NODES.get(cur);
            if (n == null) return false;
            cur = n.superName;
        }
        return false;
    }

    static boolean isSubtype(String a, String b) {
        if (a.equals(b) || OBJ.equals(b)) return true;
        Deque<String> q = new ArrayDeque<>();
        Set<String> seen = new HashSet<>();
        q.add(a);
        while (!q.isEmpty()) {
            String c = q.poll();
            if (c == null || !seen.add(c)) continue;
            ClassNode n = NODES.get(c);
            if (n == null) continue;
            if (b.equals(n.superName)) return true;
            if (n.superName != null) q.add(n.superName);
            if (n.interfaces != null) q.addAll(n.interfaces);
        }
        return false;
    }

    static String common(String a, String b) {
        if (a.equals(b)) return a;
        if (OBJ.equals(a) || OBJ.equals(b)) return OBJ;
        if (isSubtype(a, b)) return b;
        if (isSubtype(b, a)) return a;
        ClassNode na = NODES.get(a);
        if (na != null) {
            String cur = na.superName;
            while (cur != null) {
                if (isSubtype(b, cur)) return cur;
                ClassNode nc = NODES.get(cur);
                cur = nc == null ? null : nc.superName;
            }
            return OBJ;
        }
        try {
            ClassLoader cl = GuardRepair.class.getClassLoader();
            Class<?> ca = Class.forName(a.replace('/', '.'), false, cl);
            Class<?> cb = Class.forName(b.replace('/', '.'), false, cl);
            if (ca.isAssignableFrom(cb)) return a;
            if (cb.isAssignableFrom(ca)) return b;
            Class<?> sc = ca;
            while (sc != null) {
                if (sc.isAssignableFrom(cb)) return sc.getName().replace('.', '/');
                sc = sc.getSuperclass();
            }
        } catch (Throwable ignored) {
        }
        return OBJ;
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) != -1) o.write(b, 0, n);
        return o.toByteArray();
    }
}
