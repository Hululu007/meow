/**
 * 首屏请求失败的"重试判定 + 文案"。
 *
 * 为什么需要：`fetch` 在网络层失败（连接被拒、后端还没 accept）时**没有状态码**，
 * 浏览器只抛一句固定的英文 TypeError。而 TV 冷启动（尤其装完包第一次打开）时，
 * 页面比端内网关（127.0.0.1:9978）先就绪 —— 首页 `/home`、搜索的 `/search`、
 * 热播榜的 `/category` 都可能撞上，旧代码把英文原文直接贴到界面上、且不重试，
 * 用户看到的是"搜索坏了 / 整页 Failed to fetch"，其实一两秒后自己就好
 * （2026-11-16 在 .77 实测）。
 *
 * 这里只给**首屏第一次**请求重试：之后失败基本是源站/后端真挂了，反复请求
 * 只会让界面来回闪、还多打接口。
 */

/**
 * 首屏第一次请求遇到网络级失败时的重试间隔（毫秒）。
 * 0.5s 覆盖"网关刚起还有几百毫秒"，1.5s 覆盖"更慢的一次"（实测这两档能兜住）。
 */
export const FIRST_RUN_RETRY_MS = [500, 1500]

const NETWORK_FAILURE =
  /failed to fetch|networkerror|network request failed|load failed|econnrefused|econnreset/i

/** 是不是"连不上"这类网络级失败（HTTP 状态码错误不算，那种重试也没用） */
export function isNetworkFailure(e: unknown): boolean {
  const msg = String((e as { message?: unknown })?.message ?? e ?? '')
  return NETWORK_FAILURE.test(msg)
}

/**
 * 这次失败要不要自动重试：要就返回等待毫秒数，不要返回 null。
 *
 * @param firstRun   本页首屏第一次请求还没结束（冷启动竞态的判据）
 * @param retry      已经重试过几次（0 = 还没重试）
 * @param error      catch 到的原始错误
 * @param sameKeyword 失败到现在的请求目标是否没变（站点/关键词变了就别拿旧的练）
 */
export function nextRetryDelay(opts: {
  firstRun: boolean
  retry: number
  error: unknown
  sameKeyword: boolean
}): number | null {
  if (!opts.firstRun || !opts.sameKeyword) return null
  if (!isNetworkFailure(opts.error)) return null
  return FIRST_RUN_RETRY_MS[opts.retry] ?? null
}

/**
 * 给用户看的错误文案。
 *
 * 不能把浏览器原文直接透传：`Failed to fetch` 会被读成"功能坏了"或"源挂了"，
 * 而实际原因多半是后端没起来/断连，且点一下就能恢复。
 *
 * @param action 出错页面上那个按钮的名字（搜索页「重新搜索」、首页「刷新」），
 *               文案里直接指路，避免用户不知道下一步点哪
 */
export function networkErrorText(e: unknown, action = '重试'): string {
  if (isNetworkFailure(e)) return `连不上后端（可能刚启动或已断开），点「${action}」再试`
  const msg = String((e as { message?: unknown })?.message ?? e ?? '').trim()
  return msg || '请求失败'
}
