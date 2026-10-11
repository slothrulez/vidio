export function isDevelopmentMode(environment: {
  NODE_ENV?: string;
  COZE_PROJECT_ENV?: string;
} = process.env) {
  return environment.NODE_ENV !== "production" && environment.COZE_PROJECT_ENV !== "PROD";
}
