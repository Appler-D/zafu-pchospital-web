import assert from "node:assert/strict";
import test from "node:test";

import { detectInAppBrowser } from "../../src/lib/in-app-browser";

// 代表性的完整 UA 格式；当前 Android / iOS 应用与菜单行为仍需实机验收。
const android =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36";
const ios =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

test("QQ 和微信在 Android / iOS 中的明确标记触发提醒", () => {
  for (const ua of [
    `${android} V1_AND_SQ_8.9.75_4548_YYB_D QQ/8.9.75.12820 NetType/WIFI`,
    `${ios} QQ/8.9.75.604 V1_IPH_SQ_8.9.75_1_APP_A Pixel/3 Core/WKWebView`,
  ]) {
    assert.equal(detectInAppBrowser(ua), "qq");
  }
  for (const ua of [
    `${android} MQQBrowser/6.2 TBS/046285 MicroMessenger/8.0.40.2420 NetType/WIFI Language/zh_CN`,
    `${ios} MicroMessenger/8.0.40(0x1800282a) NetType/WIFI Language/zh_CN`,
  ]) {
    assert.equal(detectInAppBrowser(ua), "wechat");
  }
});

test("常见独立浏览器、未知和空 UA 不显示提醒", () => {
  for (const ua of [
    "",
    "unknown-client",
    android,
    `${ios} Version/16.6 Safari/604.1`,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
    `${android} MQQBrowser/13.8 TBS/046285`,
    `${ios} QQBrowser/13.8.0`,
  ]) {
    assert.equal(detectInAppBrowser(ua), null, ua);
  }
});

test("桌面 QQ / 微信不触发手机浏览器提醒，Mobile 标记不改变设备判定", () => {
  const desktops = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
  ];
  for (const desktop of desktops) {
    for (const marker of ["QQ/9.9.16", "MicroMessenger/4.0.0", "Mobile MicroMessenger/4.0.0"])
      assert.equal(detectInAppBrowser(`${desktop} ${marker}`), null);
  }
  for (const ua of ["QQ/9.0.0", "MicroMessenger/8.0.40", "Mobile MicroMessenger/8.0.40"])
    assert.equal(detectInAppBrowser(ua), null);
});

test("标记大小写、边界和版本号：不把相似名称或任意子串当成 QQ", () => {
  assert.equal(detectInAppBrowser(`${android} qq/9.0.0`), "qq");
  assert.equal(detectInAppBrowser(`${ios} micromessenger/8.0.40`), "wechat");
  for (const marker of [
    "NotQQ/9.0",
    "X-QQ/9.0",
    "QQ/",
    "QQ/latest",
    "QQ/9.0beta",
    "NotMicroMessenger/8.0",
  ])
    assert.equal(detectInAppBrowser(`${android} ${marker}`), null, marker);
});
