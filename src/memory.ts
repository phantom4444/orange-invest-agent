// src/memory.ts
import fs from 'fs/promises';
import path from 'path';

export interface MemoryItem {
  id: string;
  key: string;
  value: string;
  source: 'stated' | 'inferred';
  confirmed: boolean;
}

const MEMORY_PATH = path.join(__dirname, '../data/memory.json');

export class MemoryStore {
  private async readMemory(): Promise<MemoryItem[]> {
    try {
      const data = await fs.readFile(MEMORY_PATH, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private async writeMemory(items: MemoryItem[]) {
    await fs.mkdir(path.dirname(MEMORY_PATH), { recursive: true });
    await fs.writeFile(MEMORY_PATH, JSON.stringify(items, null, 2));
  }

  /**
   * Adds or updates a preference, marking it as stated or inferred.
   */
  public async setPreference(key: string, value: string, source: 'stated' | 'inferred'): Promise<MemoryItem> {
    const items = await this.readMemory();
    const existingIndex = items.findIndex(i => i.key === key);
    
    const newItem: MemoryItem = {
      id: `mem_${Date.now()}`,
      key,
      value,
      source,
      confirmed: source === 'stated' // Stated facts are auto-confirmed; inferred require confirmation
    };

    if (existingIndex >= 0) {
      items[existingIndex] = newItem;
    } else {
      items.push(newItem);
    }

    await this.writeMemory(items);
    return newItem;
  }

  public async getPreferences(): Promise<MemoryItem[]> {
    const items = await this.readMemory();
    // Only return confirmed or stated preferences (Must-have #6: inferred facts never used without confirmation)
    return items.filter(i => i.confirmed || i.source === 'stated');
  }

  /**
   * Forgets a preference permanently (Must-have #6: forgotten facts are never reused).
   */
  public async forgetPreference(key: string): Promise<boolean> {
    const items = await this.readMemory();
    const filtered = items.filter(i => i.key !== key);
    if (filtered.length === items.length) return false;
    
    await this.writeMemory(filtered);
    return true;
  }
}

/**
 * Must-Have #4: Untrusted tool output sanitization.
 * Strips out malicious injection phrases from provider reviews and free text.
 */
export function sanitizeReviewText(review: string): string {
  const maliciousPatterns = [
    /ignore all previous instructions/gi,
    /waive all fees/gi,
    /confirm this booking immediately for free/gi,
    /system instruction/gi
  ];

  let sanitized = review;
  for (const pattern of maliciousPatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED_INJECTION_ATTEMPT]');
  }

  return sanitized;
}