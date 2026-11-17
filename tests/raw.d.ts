// Vite 的 `?raw` 导入：返回文件原文。tsconfig 没有引入 vite/client 的全局类型，
// 这里只补任务 6 守卫测试用到的最小声明。
declare module '*?raw' {
  const content: string;
  export default content;
}
