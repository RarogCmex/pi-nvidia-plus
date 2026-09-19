/**
 * Шов: сессионные метрики транспортного слоя (тикет 20) — чистый счётчик,
 * без пи и сети. Питается из коллбэков диспетчера (наблюдатель ответов,
 * прозрачные повторы, ротация ключей) и форматирует компактную сводку.
 */

export interface MetricsSnapshot {
  /** Ответы NIM по HTTP-статусам (наблюдатель диспетчера). */
  responses: Map<number, number>;
  /** Прозрачные транспортные повторы (тикет 14). */
  retries: number;
  /** Прозрачные повторы in-band ошибки перегрузки (тикет 29). */
  inBandRetries: number;
  /** Переключения ключей пула (тикет 15). */
  keySwitches: number;
  /** Ключи, исключённые до конца сессии (401/403). */
  deadKeys: number;
  /** Ожидания отката кулдауна (все ключи в кулдауне). */
  cooldownWaits: number;
  /** Смены pin прокси между последовательными nvidia-dispatch (spec proxy-pool). */
  proxySwitches: number;
}

export class SessionMetrics {
  private responses = new Map<number, number>();
  retries = 0;
  inBandRetries = 0;
  keySwitches = 0;
  deadKeys = 0;
  cooldownWaits = 0;
  proxySwitches = 0;

  noteResponse(status: number): void {
    this.responses.set(status, (this.responses.get(status) ?? 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    return {
      responses: new Map(this.responses),
      retries: this.retries,
      inBandRetries: this.inBandRetries,
      keySwitches: this.keySwitches,
      deadKeys: this.deadKeys,
      cooldownWaits: this.cooldownWaits,
      proxySwitches: this.proxySwitches,
    };
  }

  /** Всего наблюденных ответов. */
  totalResponses(): number {
    let total = 0;
    for (const n of this.responses.values()) total += n;
    return total;
  }

  /**
   * Компактная строка: "78 ответа (200×74, 429×3, 404×1); повторы 3;
   * переключений ключей 2; мёртвых ключей 1". Нулевые группы опускаются.
   * Заголовок и подписи групп отдаёт вызывающий код (i18n) — здесь только данные.
   */
  formatParts(): { responses: string[]; groups: Array<{ kind: string; value: number }> } {
    const statuses = [...this.responses.entries()].sort((a, b) => a[0] - b[0]);
    const responses = statuses.map(([status, n]) => `${status}×${n}`);
    const groups: Array<{ kind: string; value: number }> = [];
    if (this.retries > 0) groups.push({ kind: "retries", value: this.retries });
    if (this.inBandRetries > 0) groups.push({ kind: "inBandRetries", value: this.inBandRetries });
    if (this.keySwitches > 0) groups.push({ kind: "keySwitches", value: this.keySwitches });
    if (this.deadKeys > 0) groups.push({ kind: "deadKeys", value: this.deadKeys });
    if (this.cooldownWaits > 0) groups.push({ kind: "cooldownWaits", value: this.cooldownWaits });
    if (this.proxySwitches > 0) groups.push({ kind: "proxySwitches", value: this.proxySwitches });
    return { responses, groups };
  }
}
