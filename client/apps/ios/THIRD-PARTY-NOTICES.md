# Third-party notices

## OpenJDK 9 (Zero)

This app embeds a prebuilt OpenJDK 9 Zero runtime for iOS arm64 from
https://github.com/Oct4Pie/lib-openjdk-9-ios (forked from the OpenJDK Mobile
project). OpenJDK is licensed under GPLv2 with the Classpath Exception.

- Runtime bundle: `lib-openjdk-9_ios-arm64_bundle.tar.gz`
- libffi: `libffi-3.3_ios-arm64_bundle.tar.gz`
- OpenJDK source: https://openjdk.org/ (mobile project: https://github.com/openjdk/mobile)

The app is distributed as an unsigned/sideload IPA for personal use; it is not
submitted to the App Store. The GPL part remains the JVM runtime; the Meow
application code keeps its own license.

## Readiness note

The prebuilt runtime is from 2020. Verify JNI_CreateJavaVM, signal handling,
TLS (cacerts), and file/network access on the target iOS version before
treating this as a supported distribution.
