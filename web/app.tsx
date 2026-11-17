import { Shell } from './components/Shell';
import { Overview } from './routes/Overview';
import { Services } from './routes/Services';
import { ServiceDetail } from './routes/ServiceDetail';

/** P0 只有三个页面，最小 pathname 路由；不做 history 封装，链接走整页跳转。 */
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const detail = path.match(/^\/services\/([^/]+)$/);

  if (detail?.[1]) {
    return (
      <Shell active="/services">
        <ServiceDetail slug={decodeURIComponent(detail[1])} />
      </Shell>
    );
  }

  if (path === '/services') {
    return (
      <Shell active="/services">
        <Services />
      </Shell>
    );
  }

  return (
    <Shell active="/">
      <Overview />
    </Shell>
  );
}
