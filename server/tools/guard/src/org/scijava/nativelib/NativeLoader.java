package org.scijava.nativelib;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.security.MessageDigest;

/** 最小实现：从 unicorn jar 的 natives/<platform>/ 取原生库，按内容哈希落盘后 System.load。 */
public class NativeLoader {
    public static void loadLibrary(String libName, String[] searchPaths) throws IOException {
        String os = System.getProperty("os.name", "").toLowerCase();
        String arch = System.getProperty("os.arch", "").toLowerCase();
        String platform, fileName;
        if (os.contains("win")) {
            platform = arch.contains("64") ? "windows_64" : "windows_32";
            fileName = libName + ".dll";
        } else if (os.contains("mac") || os.contains("darwin")) {
            platform = arch.contains("aarch64") ? "osx_arm64" : "osx_64";
            fileName = "lib" + libName + ".dylib";
        } else {
            platform = arch.contains("aarch64") ? "linux_arm64" : "linux_64";
            fileName = "lib" + libName + ".so";
        }
        String resource = "natives/" + platform + "/" + fileName;
        InputStream in = NativeLoader.class.getClassLoader().getResourceAsStream(resource);
        if (in == null) throw new IOException("native library not found: " + resource);
        byte[] bytes;
        try (InputStream i = in) { bytes = i.readAllBytes(); }
        String hash = sha256(bytes).substring(0, 16);
        File dir = new File(new File(System.getProperty("user.home", "."), ".meow-guard-native"), hash);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("mkdir failed: " + dir);
        File target = new File(dir, fileName);
        if (!target.isFile() || target.length() != bytes.length) {
            File tmp = File.createTempFile("native-", ".part", dir);
            try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(bytes); }
            Files.move(tmp.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
        System.load(target.getAbsolutePath());
        System.out.println("[NativeLoader] " + resource + " -> " + target);
    }
    private static String sha256(byte[] b) {
        try {
            StringBuilder sb = new StringBuilder();
            for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) { return "x"; }
    }
}
