export interface ModelCredentialStatus {
  dashscopeConfigured: boolean;
  deepseekConfigured: boolean;
}

export interface ModelCredentialUpdate {
  dashscopeApiKey?: string | null;
  deepseekApiKey?: string | null;
}
