package core;

import com.googlecode.d2j.dex.Dex2jar;
import com.googlecode.d2j.reader.BaseDexFileReader;
import com.googlecode.d2j.reader.MultiDexFileReader;
import com.googlecode.dex2jar.tools.BaksmaliBaseDexExceptionHandler;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * iOS 端内 dex → class 转换：直接调 dex2jar 库，不 fork 子进程。
 *
 * <p>iOS 没有 exec，宿主进程内的 {@code ProcessBuilder} 必失败；PC/Docker 仍走
 * {@code Dex2Jvm.run()} 的外部命令（独立进程更抗 OOM，且可换版本）。
 * 由 {@code -Dmeow.dex2jar.inprocess=true} 触发，转换器 jar 在应用的 jvm/libs 下。
 *
 * <p>主路径用 {@code Dex2jar.to(Path)} + jdk.zipfs，与 PC 产物一致；嵌入式 JDK 镜像
 * 缺 jdk.zipfs 时才退化成"目录 + 手工 zip"。目录模式要求**大小写敏感**的文件系统：
 * 源包里存在仅大小写不同的类（{@code merge.H.a} 与 {@code merge.h.a}，实测 344 组），
 * 在 NTFS/默认 APFS 上会互相覆盖；iOS 的 APFS 是大小写敏感的。
 * 只做字节码翻译，不加载也不会执行被转换的类。
 */
public final class Dex2JvmInProcess {

    private Dex2JvmInProcess() {
    }

    /**
     * 把 dex jar 转成 class jar。
     *
     * @return null 表示成功；否则是给 {@code _dex2jvm} 提示用的错误描述
     */
    public static String convert(File src, File out) {
        try {
            byte[] bytes = Files.readAllBytes(src.toPath());
            try {
                translate(bytes, out.toPath());
                return null;
            } catch (IOException e) {
                if (e.getMessage() != null && e.getMessage().contains("zipfs")) {
                    translateToDir(bytes, out.toPath());
                    return null;
                }
                throw e;
            }
        } catch (Throwable t) {
            String msg = t.getMessage();
            return t.getClass().getSimpleName() + (msg == null ? "" : ": " + msg);
        }
    }

    private static void translate(byte[] dex, Path out) throws IOException {
        BaseDexFileReader reader = MultiDexFileReader.open(dex);
        Dex2jar.from(reader)
                .withExceptionHandler(new BaksmaliBaseDexExceptionHandler())
                .reUseReg(true)
                .topoLogicalSort()
                .skipDebug(false)
                .optimizeSynchronized(true)
                .to(out);
    }

    private static void translateToDir(byte[] dex, Path out) throws Exception {
        Path dir = out.resolveSibling(out.getFileName() + ".classes");
        try {
            deleteTree(dir);
            Files.createDirectories(dir);
            translate(dex, dir);
            zipTree(dir, out);
        } finally {
            try {
                deleteTree(dir);
            } catch (Throwable ignored) {
            }
        }
    }

    private static void zipTree(Path dir, Path out) throws Exception {
        List<Path> files = new ArrayList<>();
        try (Stream<Path> s = Files.walk(dir)) {
            s.filter(Files::isRegularFile).forEach(files::add);
        }
        // 固定顺序，产物可复现（缓存键按源 sha 命名，内容不应随机变化）
        files.sort(Comparator.comparing((Path p) -> dir.relativize(p).toString()));
        Files.deleteIfExists(out);
        try (OutputStream fos = new BufferedOutputStream(Files.newOutputStream(out));
             ZipOutputStream zos = new ZipOutputStream(fos)) {
            for (Path f : files) {
                String name = dir.relativize(f).toString().replace(File.separatorChar, '/');
                zos.putNextEntry(new ZipEntry(name));
                try (InputStream in = Files.newInputStream(f)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) != -1) zos.write(buf, 0, n);
                }
                zos.closeEntry();
            }
        }
    }

    private static void deleteTree(Path dir) throws Exception {
        if (!Files.exists(dir)) return;
        try (Stream<Path> s = Files.walk(dir)) {
            List<Path> all = new ArrayList<>();
            s.forEach(all::add);
            all.sort(Comparator.reverseOrder());
            for (Path p : all) Files.deleteIfExists(p);
        }
    }
}
