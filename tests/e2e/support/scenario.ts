import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const scenarioPath = resolve(import.meta.dirname, '../../../.local/scenario.json');
const scenario = existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : { worldwideDay: 20260804 };

export const worldwideDay: number = scenario.worldwideDay;

export const auctionRoute = `/auction/${worldwideDay}`;
