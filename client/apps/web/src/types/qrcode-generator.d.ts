/**
 * `qrcode-generator` 的类型声明。
 *
 * 只声明我们实际用到的部分（构造 + addData + make + getModuleCount + isDark）。
 * 库是 vendored 的 UMD 单文件，上游不带 d.ts，所以手写这一小块——
 * 比给整个 56KB 源码套一遍类型划算，也能把"我们依赖了哪些能力"显式记下来。
 */
declare module '*/vendor/qrcode-generator.mjs' {
  export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H'

  export interface QrCode {
    addData(data: string, mode?: string): void
    make(): void
    getModuleCount(): number
    /** @param row 行（y） @param col 列（x） */
    isDark(row: number, col: number): boolean
  }

  /**
   * @param typeNumber 0 = 自动选最小可用版本
   * @param errorCorrectionLevel 纠错等级
   */
  export default function qrcode(
    typeNumber: number,
    errorCorrectionLevel: QrErrorCorrection,
  ): QrCode
}
