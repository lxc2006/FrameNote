export interface ModelCredentialStatus {
  dashscopeConfigured: boolean;
  deepseekConfigured: boolean;
  serpApiConfigured: boolean;
  zhipuSearchConfigured: boolean;
}

export interface ModelCredentialUpdate {
  dashscopeApiKey?: string | null;
  deepseekApiKey?: string | null;
  serpApiKey?: string | null;
  zhipuSearchApiKey?: string | null;
}
