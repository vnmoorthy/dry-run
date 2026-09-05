/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * Hand-authored to match `npx convex codegen` output so the project typechecks
 * before a deployment exists; `npx convex dev` regenerates this file.
 */

import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server';
import type * as entities from '../entities.js';
import type * as gauntlets from '../gauntlets.js';
import type * as jobs from '../jobs.js';
import type * as mint from '../mint.js';
import type * as planner from '../planner.js';
import type * as robot from '../robot.js';
import type * as room from '../room.js';
import type * as tasks from '../tasks.js';
import type * as tripo from '../tripo.js';
import type * as worldlabs from '../worldlabs.js';

declare const fullApi: ApiFromModules<{
  entities: typeof entities;
  gauntlets: typeof gauntlets;
  jobs: typeof jobs;
  mint: typeof mint;
  planner: typeof planner;
  robot: typeof robot;
  room: typeof room;
  tasks: typeof tasks;
  tripo: typeof tripo;
  worldlabs: typeof worldlabs;
}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, 'public'>>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, 'internal'>>;
