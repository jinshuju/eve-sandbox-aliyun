# Changelog

## [0.3.1](https://github.com/jinshuju/eve-sandbox-aliyun/compare/v0.3.0...v0.3.1) (2026-09-26)


### Fixes

* declare the provider's own session type for eve &gt;=0.66 ([#17](https://github.com/jinshuju/eve-sandbox-aliyun/issues/17)) ([0a90e42](https://github.com/jinshuju/eve-sandbox-aliyun/commit/0a90e423db7ae98e1a9cc0159b3d7439c5b75ce7))

## [0.3.0](https://github.com/jinshuju/eve-sandbox-aliyun/compare/v0.2.1...v0.3.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* requires eve >=0.64.0. aliyun() is replaced by AliyunSandbox.environment(options); bootstrap becomes the environment's prepare option, and onSession's use({ env, networkPolicy }) becomes environment.open({ env, networkPolicy }) in defineSandbox's selector. revalidationKey is gone. Sessions created with 0.2.x cannot be resumed.

### Features

* port to eve 0.64's sandbox provider API ([1e8e20c](https://github.com/jinshuju/eve-sandbox-aliyun/commit/1e8e20ce70aebdf91490645651587c4eb8616a18))

## [0.2.1](https://github.com/jinshuju/eve-sandbox-aliyun/compare/v0.2.0...v0.2.1) (2026-09-21)


### Fixes

* capture templates and checkpoints on BusyBox-based images ([aa10d9b](https://github.com/jinshuju/eve-sandbox-aliyun/commit/aa10d9bcbbea8a5fecafb3d2ac5d7a954de9cb10))
* capture templates and checkpoints on BusyBox-based images ([95913e3](https://github.com/jinshuju/eve-sandbox-aliyun/commit/95913e37cc648265af51a50272c4b1181f1e9c55))
* do not report a capture as done without an archive ([9625c57](https://github.com/jinshuju/eve-sandbox-aliyun/commit/9625c570735e0d04445ad55a590a9e8c97217b9e))

## [0.2.0](https://github.com/jinshuju/eve-sandbox-aliyun/compare/v0.1.1...v0.2.0) (2026-09-20)


### Features

* per-session environment through use({ env }) ([3465215](https://github.com/jinshuju/eve-sandbox-aliyun/commit/346521513336893d82f34427cbaad4a7269915cc))
* per-session environment through use({ env }), and a sweep script ([2762d3a](https://github.com/jinshuju/eve-sandbox-aliyun/commit/2762d3aa3385f1ec409f14bf43ea68b3a125b54e))
* sweep script for sandboxes left running in the account ([7aee54c](https://github.com/jinshuju/eve-sandbox-aliyun/commit/7aee54c8bb1a460ff3500183cab4918e25061c1c))

## [0.1.1](https://github.com/jinshuju/eve-sandbox-aliyun/compare/v0.1.0...v0.1.1) (2026-09-20)


### Documentation

* add the npm version badge ([471155e](https://github.com/jinshuju/eve-sandbox-aliyun/commit/471155edd7551f5fe6a512b100594f96597fcf88))
