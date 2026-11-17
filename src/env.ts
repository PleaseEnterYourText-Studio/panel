export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  ENCRYPTION_KEY: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /**
   * 运行环境判定位。只有显式等于 'development' 时才允许 DEV_BYPASS_EMAIL 生效，
   * 其余取值（含未设置）一律忽略 bypass —— 不能靠「有没有绑定 secret」来判断环境。
   */
  PANEL_ENV?: string;
  /** 本地开发用的假身份。必须同时满足 PANEL_ENV === 'development' 才生效。 */
  DEV_BYPASS_EMAIL?: string;
}

export const APP_VERSION = '0.1.0';
