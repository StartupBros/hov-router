import { BaseRepository } from "./base.repository";

export interface ModelTranslation {
	client_name: string;
	bedrock_model_id: string;
	is_default: boolean;
	auto_discovered: boolean;
}

export interface SimilarModel {
	client_name: string;
	similarity: number;
}

/**
 * Repository for managing model name translations between client-friendly names
 * and Bedrock model IDs.
 *
 * Enables users to request models using familiar Claude API names (e.g., "claude-3-5-sonnet")
 * while the proxy translates to Bedrock format (e.g., "us.anthropic.claude-3-5-sonnet-20241022-v2:0").
 */
export class ModelTranslationRepository extends BaseRepository<ModelTranslation> {
	/**
	 * Find similar model names for "Did you mean?" suggestions
	 * Uses simple substring matching for fuzzy search
	 * @param clientName - The model name to find suggestions for
	 * @param maxResults - Maximum number of results to return (default: 5)
	 * @returns Array of similar model names with similarity scores
	 */
	async findSimilar(
		clientName: string,
		maxResults = 5,
	): Promise<SimilarModel[]> {
		const allTranslations = await this.query<{ client_name: string }>(
			`SELECT client_name FROM model_translations ORDER BY client_name`,
		);

		const searchTerm = clientName.toLowerCase();
		const results: Array<{ client_name: string; similarity: number }> = [];

		for (const translation of allTranslations) {
			const targetName = translation.client_name.toLowerCase();

			// Exact match gets highest score
			if (targetName === searchTerm) {
				results.push({ client_name: translation.client_name, similarity: 1.0 });
				continue;
			}

			// Substring match
			if (targetName.includes(searchTerm) || searchTerm.includes(targetName)) {
				results.push({
					client_name: translation.client_name,
					similarity: 0.8,
				});
				continue;
			}

			// Simple Levenshtein-like distance for partial matches
			const distance = this._levenshteinDistance(searchTerm, targetName);
			const maxLength = Math.max(searchTerm.length, targetName.length);
			const similarity = 1 - distance / maxLength;

			// Only include reasonably similar matches (similarity >= 0.5)
			if (similarity >= 0.5) {
				results.push({
					client_name: translation.client_name,
					similarity,
				});
			}
		}

		// Sort by similarity (descending) and return top N
		return results
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, maxResults);
	}

	/**
	 * Calculate Levenshtein distance between two strings
	 * @param a - First string
	 * @param b - Second string
	 * @returns Number of edits required to transform a into b
	 */
	private _levenshteinDistance(a: string, b: string): number {
		const matrix: number[][] = [];

		// Initialize matrix
		for (let i = 0; i <= b.length; i++) {
			matrix[i] = [i];
		}
		for (let j = 0; j <= a.length; j++) {
			matrix[0][j] = j;
		}

		// Fill matrix
		for (let i = 1; i <= b.length; i++) {
			for (let j = 1; j <= a.length; j++) {
				if (b.charAt(i - 1) === a.charAt(j - 1)) {
					matrix[i][j] = matrix[i - 1][j - 1];
				} else {
					matrix[i][j] = Math.min(
						matrix[i - 1][j - 1] + 1, // substitution
						matrix[i][j - 1] + 1, // insertion
						matrix[i - 1][j] + 1, // deletion
					);
				}
			}
		}

		return matrix[b.length][a.length];
	}
}
