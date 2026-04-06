// src/types/index.ts
export interface FieldMappingConfig {
  mappings: Array<{
    wixField: string;
    hubSpotProperty: string;
    direction: 'wix_to_hubspot' | 'hubspot_to_wix' | 'bidirectional';
    transform?: 'trim' | 'lowercase' | 'uppercase' | 'email';
  }>;
}

export interface HubSpotTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  hub_domain: string;
  hub_id: number;
  user_id: number;
}

export interface WixContact {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  customFields?: Record<string, any>;
  version?: number;
}

export interface HubSpotContact {
  id: string;
  properties: {
    email?: string;
    firstname?: string;
    lastname?: string;
    phone?: string;
    [key: string]: any;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface UTMParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  page_url?: string;
  referrer?: string;
  timestamp?: string;
}