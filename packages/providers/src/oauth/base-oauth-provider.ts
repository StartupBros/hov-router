export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
}
