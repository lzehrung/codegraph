---
section: Fixed
---

Native x86-64 addons no longer require AVX2: parser C/C++ code targets the x86-64/SSE2 baseline, and release checks reject instructions above that baseline and uninspectable IR/LTO objects. PR CI also exercises parsing and queries on an emulated SandyBridge CPU. Shipping this fix requires a new native addon release.
