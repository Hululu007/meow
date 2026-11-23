package core;

import org.json.JSONObject;

/**
 * iOS 构建用的 Dex2Jvm 桩。
 *
 * <p>真实实现靠外部 dex2jar 进程 + ProcessBuilder，iOS 没有 fork/exec；
 * 端上只用 class 形态的 jar（配置里的 {@code spiderJvm} 或源包自带的 class jar），
 * 因此这里原样返回配置。需要 dex 转换时在上游（PC/CI）完成后导入。
 */
public final class Dex2Jvm {

    private Dex2Jvm() {
    }

    public static JSONObject rewrite(JSONObject doc, String configBase) {
        return doc;
    }
}
