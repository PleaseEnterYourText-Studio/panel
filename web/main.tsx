import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: '2rem' }}>
      <h1>PEYT Panel</h1>
      <p>脚手架就绪。Worker 在 127.0.0.1:8787，前端经 Vite 代理 /api。</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
