/** P0 占位：Task 10 替换为服务页（头部 + 标签页 + 检查表格）。 */
export function ServiceDetail({ slug }: { slug: string }) {
  return (
    <div>
      <h1>服务 / {slug}</h1>
      <div style={{ color: 'var(--muted)' }}>正在加载…</div>
    </div>
  );
}
