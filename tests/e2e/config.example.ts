// Copy this file to config.ts and fill in your values
// config.ts is gitignored

export interface EnvironmentConfig {
  clientId: string;
  clientSecret?: string;
  resourceUrl: string;
  baseUrl: string;
}

export const ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  local: {
    clientId: "",
    clientSecret: "",
    resourceUrl: "http://127.0.0.1:7676/article",
    baseUrl: "http://localhost:8000",
  },
  "sandbox-compute": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://stc-fastly-demo.edgecompute.app",
    baseUrl: "https://api-connect.sbx.supertab.co",
  },
  "sandbox-cloudfront": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://d2rpbtym810nyy.cloudfront.net",
    baseUrl: "https://api-connect.sbx.supertab.co",
  },
  "sandbox-vcl": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://supertab-rsl.global.ssl.fastly.net",
    baseUrl: "https://api-connect.sbx.supertab.co",
  },
  "production-compute": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://stc-fastly-demo.edgecompute.app",
    baseUrl: "https://api-connect.supertab.co",
  },
  "production-cloudfront": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://d2rpbtym810nyy.cloudfront.net",
    baseUrl: "https://api-connect.supertab.co",
  },
};
