import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const deploymentScript = readFileSync(resolve('scripts/deploy.ps1'), 'utf8');

describe('deployment timer schedule', () => {
  it('uses four sparse Moscow-schedule timer definitions instead of a minute poll', () => {
    expect(deploymentScript).toContain("$TimerDefinitions = @(");
    expect(deploymentScript).toContain("'0 7 ? * TUE *'");
    expect(deploymentScript).toContain("'10 7 ? * TUE *'");
    expect(deploymentScript).toContain("'55 17 ? * FRI *'");
    expect(deploymentScript).toContain("'5 18 ? * FRI *'");
    expect(deploymentScript).not.toContain("$CronExpression = '* * * * ? *'");
  });
});
