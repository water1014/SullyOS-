import { describe, expect, it } from 'vitest';
import { evaluateVisualAutonomy } from './autonomyPolicy';
import type { VisualAutonomySettings } from './types';

const settings: VisualAutonomySettings = {
    enabled: true,
    frequency: 'natural',
    providerPreference: 'auto',
    allowSpontaneousShare: true,
    allowPrivateCreation: false,
    requireApprovalForNewIdentity: true,
    dailyImageLimit: 3,
    dailyCreditLimit: 100,
    updatedAt: 1,
};

const context = (overrides: Partial<Parameters<typeof evaluateVisualAutonomy>[1]> = {}) => ({
    kind: 'ordinary_conversation' as const,
    now: Date.UTC(2026, 10, 4, 12),
    localTime: '12:00',
    imagesGeneratedToday: 0,
    creditsSpentToday: 0,
    estimatedCredits: 10,
    sample: 0.01,
    ...overrides,
});

describe('visual autonomous sharing policy', () => {
    it('allows a natural ordinary moment at the configured natural frequency', () => {
        expect(evaluateVisualAutonomy(settings, context())).toEqual({
            allowed: true,
            reason: 'natural_moment',
        });
    });

    it('is more receptive to special moments without bypassing safety limits', () => {
        expect(evaluateVisualAutonomy(settings, context({
            kind: 'milestone',
            sample: 0.5,
        }))).toEqual({ allowed: true, reason: 'special_moment' });
        expect(evaluateVisualAutonomy(settings, context({
            kind: 'milestone',
            imagesGeneratedToday: 3,
        }))).toEqual({ allowed: false, reason: 'daily_image_limit' });
    });

    it('honors disabled, paused and spontaneous-share switches', () => {
        expect(evaluateVisualAutonomy({ ...settings, enabled: false }, context()))
            .toEqual({ allowed: false, reason: 'disabled' });
        expect(evaluateVisualAutonomy({ ...settings, frequency: 'paused' }, context()))
            .toEqual({ allowed: false, reason: 'paused' });
        expect(evaluateVisualAutonomy({ ...settings, allowSpontaneousShare: false }, context()))
            .toEqual({ allowed: false, reason: 'spontaneous_disabled' });
    });

    it('respects overnight quiet hours and fails closed for malformed hours', () => {
        const quiet = { ...settings, quietHours: { start: '22:00', end: '08:00' } };
        expect(evaluateVisualAutonomy(quiet, context({ localTime: '23:15' })))
            .toEqual({ allowed: false, reason: 'quiet_hours' });
        expect(evaluateVisualAutonomy(quiet, context({ localTime: '07:30' })))
            .toEqual({ allowed: false, reason: 'quiet_hours' });
        expect(evaluateVisualAutonomy(quiet, context({ localTime: '12:00' })).allowed).toBe(true);
        expect(evaluateVisualAutonomy({ ...settings, quietHours: { start: 'bad', end: '08:00' } }, context()))
            .toEqual({ allowed: false, reason: 'quiet_hours' });
    });

    it('enforces cooldown and probability selection', () => {
        expect(evaluateVisualAutonomy(settings, context({
            lastShareAt: Date.UTC(2026, 10, 4, 8),
        }))).toEqual({ allowed: false, reason: 'cooldown' });
        expect(evaluateVisualAutonomy(settings, context({ sample: 0.9 })))
            .toEqual({ allowed: false, reason: 'not_selected' });
    });

    it('enforces daily credit limits and lets explicit requests bypass spontaneous-only gates', () => {
        expect(evaluateVisualAutonomy(settings, context({
            creditsSpentToday: 95,
            estimatedCredits: 10,
        }))).toEqual({ allowed: false, reason: 'daily_credit_limit' });
        expect(evaluateVisualAutonomy({ ...settings, allowSpontaneousShare: false }, context({
            kind: 'user_requested',
            localTime: '23:30',
            lastShareAt: Date.UTC(2026, 10, 4, 11, 59),
        }))).toEqual({ allowed: true, reason: 'user_requested' });
    });

    it('rejects invalid random samples', () => {
        expect(evaluateVisualAutonomy(settings, context({ sample: 1 })))
            .toEqual({ allowed: false, reason: 'invalid_context' });
    });
});
