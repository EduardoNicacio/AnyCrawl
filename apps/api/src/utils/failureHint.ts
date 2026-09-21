import { RequestWithAuth, getPlanLimits, buildUpgradeHint, type UpgradeHint } from "@anycrawl/libs";

export interface FailureFields {
    error_code?: string;
    upgrade?: UpgradeHint;
}

/**
 * Extra, additive fields for a failed scrape response: the failure class the
 * worker recorded, and — only for a plan without a stealth proxy whose page was
 * blocked — a pointer to the plan that has one.
 */
export function failureFields(req: RequestWithAuth, jobData: { failure_class?: unknown } | undefined): FailureFields {
    const failureClass = jobData?.failure_class;
    if (typeof failureClass !== "string") return {};
    const fields: FailureFields = { error_code: failureClass };
    const upgrade = buildUpgradeHint(failureClass, getPlanLimits(req.auth?.subscriptionTier));
    if (upgrade) fields.upgrade = upgrade;
    return fields;
}
