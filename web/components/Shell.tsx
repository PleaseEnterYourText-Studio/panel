import type { ReactNode } from 'react';

/**
 * P0 外壳：40px 顶栏（品牌 + ⌘K 搜索占位 + 用户名）+ 左栏（Fleet / Operate / Account）
 * + 内容区。路由高亮由调用方传入的 active 决定（详情页归到列表项下）。
 */
export function Shell({ children, active }: { children: ReactNode; active: string }) {
  const item = (href: string, label: string, badge?: string) => (
    <a href={href} className={active === href ? 'on' : ''}>
      <span>{label}</span>
      {badge ? <span className="pill">{badge}</span> : null}
    </a>
  );

  return (
    <div className="shell">
      <div className="topbar">
        <span className="brand">PEYT</span>
        <span className="user">Panel</span>
        <input className="search" placeholder="⌘K 搜索服务 / 服务器 / URL" readOnly />
        <span className="user">NoWint</span>
      </div>
      <div className="body">
        <nav className="rail" aria-label="主导航">
          <div className="k">Fleet</div>
          {item('/', '概览')}
          {item('/servers', '服务器')}
          {item('/services', '服务')}
          {item('/quota', '证书 / 域名')}
          <div className="k">Operate</div>
          {item('/deploys', '部署')}
          {item('/incidents', '事件')}
          <div className="k">Account</div>
          {item('/members', '成员')}
          {item('/audit', '审计')}
        </nav>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
