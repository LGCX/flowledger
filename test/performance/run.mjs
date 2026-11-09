#!/usr/bin/env node
/**
 * Performance-lane placeholder.
 *
 * docs/10 §M0 requires the command to exist from P00 so CI and the developer guide can name it,
 * and P12 replaces this file with real measurements. It exits 0 deliberately: a lane that fails
 * until it is implemented would either be deleted or muted, and a silently skipped lane is worse
 * than an honest placeholder that says so.
 */
import process from 'node:process';

process.stdout.write('test:performance: not implemented until P12\n');
