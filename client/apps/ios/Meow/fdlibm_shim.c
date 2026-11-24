/*
 * iOS 的 OpenJDK 9 静态包里缺 libfdlibm.a，StrictMath 的原生方法引用 j* 符号。
 * 这里用系统 libm 提供同名包装：数值可能与 fdlibm 末位有差异，但爬虫/解析
 * 不依赖 StrictMath 的 bit-exact 语义。
 */
#include <math.h>

double jsin(double x) { return sin(x); }
double jcos(double x) { return cos(x); }
double jtan(double x) { return tan(x); }
double jasin(double x) { return asin(x); }
double jacos(double x) { return acos(x); }
double jatan(double x) { return atan(x); }
double jatan2(double y, double x) { return atan2(y, x); }
double jsinh(double x) { return sinh(x); }
double jcosh(double x) { return cosh(x); }
double jtanh(double x) { return tanh(x); }
double jexpm1(double x) { return expm1(x); }
double jlog(double x) { return log(x); }
double jlog10(double x) { return log10(x); }
double jlog1p(double x) { return log1p(x); }
double jsqrt(double x) { return sqrt(x); }
double jremainder(double x, double y) { return remainder(x, y); }
