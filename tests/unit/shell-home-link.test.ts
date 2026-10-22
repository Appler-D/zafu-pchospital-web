import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { shellNavigationCopy } from "../../src/config/navigation";

// 与既有组件渲染测试一致：tsx 使用经典 JSX 运行时。
(globalThis as unknown as { React: typeof React }).React = React;

const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

test("两种后台的深层页面直接显示同标签官网链接，保留品牌和关闭的账号菜单", async () => {
  const [{ AdminNav }, { MemberNav }] = await Promise.all([
    import("../../src/components/admin/AdminNav"),
    import("../../src/components/member/MemberNav"),
  ]);

  for (const [Nav, pathname, brandHref] of [
    [AdminNav, "/admin/members", "/admin"],
    [MemberNav, "/member/repairs/new", "/member"],
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(
        AppRouterContext.Provider,
        { value: router },
        React.createElement(
          PathnameContext.Provider,
          { value: pathname },
          React.createElement(Nav, { displayName: "用于验证窄屏省略的很长展示名称" }),
        ),
      ),
    );
    const homeLinks = html.match(/<a\b[^>]*href="\/"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    assert.equal(homeLinks.length, 1, `${pathname} 应恰有一个官网入口`);
    assert.ok(homeLinks[0].includes(shellNavigationCopy.backHome));
    assert.doesNotMatch(homeLinks[0], /\btarget=|role="menuitem"|aria-hidden="true"[^>]*>返回/);
    assert.ok(html.includes(`href="${brandHref}"`), "原后台品牌仍指向自己的工作台");
    assert.match(html, /aria-label="账号菜单"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /class="account-menu__panel"/, "无需展开账号菜单即可返回官网");
    assert.ok(html.indexOf(homeLinks[0]) < html.indexOf('class="account-menu account-menu--nav"'));
  }
});
