import type { VisualAutonomySettings } from './types';

export type VisualShareContextKind =
    | 'ordinary_conversation'
    | 'emotional_high'
    | 'milestone'
    | 'reunion'
    | 'user_requested';

export interface VisualAutonomyContext {
    kind: VisualShareContextKind;
    now: number;
    localTime: string; // HH:mm, resolved by the caller in the user's local timezone.
    lastShareAt?: number;
    imagesGeneratedToday: number;
    creditsSpentToday?: number;
    estimatedCredits?: number;
    /** 0 <= value < 1. Injected for deterministic tests and caller-controlled randomness. */
    sample: number;
}

export type VisualAutonomyDecision =
    | { allowed: true; reason: 'user_requested' | 'special_moment' | 'natural_moment' }
    | { allowed: false; reason: 'disabled' | 'paused' | 'spontaneous_disabled' | 'quiet_hours' | 'daily_image_limit' | 'daily_credit_limit' | 'cooldown' | 'not_selected' | 'invalid_context' };

const FREQUENCY_RULES = {
    low: { ordinaryChance: 0.04, specialChance: 0.35, cooldownMs: 24 * 60 * 60_000 },
    natural: { ordinaryChance: 0.12, specialChance: 0.65, cooldownMs: 8 * 60 * 60_000 },
    high: { ordinaryChance: 0.25, specialChance: 0.85, cooldownMs: 3 * 60 * 60_000 },
} as const;

function parseClock(value: string): number | null {
    const match = /^(?:([01]\\d|2[0-3])):([0-5]\\d)$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function isQuietTime(now: string, quietHours?: { start: string; end: string }): boolean {
    if (!quietHours) return false;
    const current = parseClock(now);
    const start = parseClock(quietHours.start);
    const end = parseClock(quietHours.end);
    // Invalid settings fail closed: never send an unsolicited image if quiet hours are malformed.
    if (current === null || start === null || end === null) return true;
    if (start === end) return true;
    return start < end
        ? current >= start && current < end
        : current >= start || current < end;
}

/**
 * Pure policy gate for autonomous image sharing.
 * Explicit user requests bypass spontaneous-share settings and cooldowns, but still respect
 * global enablement, paused mode, and daily budget limits.
 */
export function evaluateVisualAutonomy(
    settings: VisualAutonomySettings,
    context: VisualAutonomyContext,
): VisualAutonomyDecision {
    if (!Number.isFinite(context.now) || !Number.isFinite(context.sample) || context.sample < 0 || context.sample >= 1) {
        return { allowed: false, reason: 'invalid_context' };
    }
    if (!settings.enabled) return { allowed: false, reason: 'disabled' };
    if (settings.frequency === 'paused') return { allowed: false, reason: 'paused' };

    if (context.imagesGeneratedToday >= Math.max(0, settings.dailyImageLimit)) {
        return { allowed: false, reason: 'daily_image_limit' };
    }
    if (settings.dailyCreditLimit !== undefined
        && (context.creditsSpentToday || 0) + (context.estimatedCredits || 0) > settings.dailyCreditLimit) {
        return { allowed: false, reason: 'daily_credit_limit' };
    }

    if (context.kind === 'user_requested') {
        return { allowed: true, reason: 'user_requested' };
    }
    if (!settings.allowSpontaneousShare) {
        return { allowed: false, reason: 'spontaneous_disabled' };
    }
    if (isQuietTime(context.localTime, settings.quietHours)) {
        return { allowed: false, reason: 'quiet_hours' };
    }

    const rules = FREQUENCY_RULES[settings.frequency];
    if (context.lastShareAt !== undefined && context.now - context.lastShareAt < rules.cooldownMs) {
        return { allowed: false, reason: 'cooldown' };
    }

    const special = context.kind === 'emotional_high'
        || context.kind === 'milestone'
        || context.kind === 'reunion';
    const chance = special ? rules.specialChance : rules.ordinaryChance;
    if (context.sample >= chance) return { allowed: false, reason: 'not_selected' };
    return { allowed: true, reason: special ? 'special_moment' : 'natural_moment' };
}
