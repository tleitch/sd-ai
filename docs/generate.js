#!/usr/bin/env node
/**
 * Generates docs/data/leaderboard.json from full benchmark results + model profiles.
 * Run from repo root: node docs/generate.js
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load model profiles ──────────────────────────────────────────────────────
const profileDir = join(ROOT, 'evals/model-profiles');
const profiles = {};
for (const f of readdirSync(profileDir)) {
    if (!f.endsWith('.json')) continue;
    const p = JSON.parse(readFileSync(join(profileDir, f), 'utf8'));
    profiles[p.alias] = p;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findAlias(configName) {
    // Match longest alias that appears in configName (greedy to avoid partial matches)
    let best = null;
    for (const alias of Object.keys(profiles)) {
        if (configName.includes(alias) && (!best || alias.length > best.length)) {
            best = alias;
        }
    }
    return best;
}

function isCloud(alias) {
    if (!alias) return true; // unknown → assume cloud
    const cloudKeywords = ['gpt', 'gemini', 'claude', 'o1', 'o3', 'o4', 'GPT', 'Gemini', 'Claude'];
    return cloudKeywords.some(k => alias.toLowerCase().includes(k.toLowerCase()));
}

function inferCloudFromConfig(configName) {
    const cloud = ['gpt', 'gemini', 'claude', 'o1-', 'o3-', 'o4-', 'sonnet', 'opus', 'haiku'];
    return cloud.some(k => configName.toLowerCase().includes(k));
}

function backendLabel(profile) {
    if (!profile) return 'unknown';
    const b = (profile.inferenceBackend || '').toLowerCase();
    if (b === 'mlx_lm') return 'mlx_lm';
    if (b === 'llama.cpp' || b === 'llamacpp') return 'llama.cpp';
    return b || 'unknown';
}

function modelFamilyName(alias) {
    if (!alias) return alias;
    // Strip quantization / variation suffixes to get a human-readable family name
    return alias
        .replace(/-MLX-\d+(\.\d+)?(bit)?$/i, '')
        .replace(/-Q\d+_K_[ML]$/i, '')
        .replace(/-GGUF-Q\d+.*$/i, '')
        .replace(/-IQ\d+.*$/i, '')
        .replace(/-DQ\d+.*$/i, '')
        .replace(/_/g, ' ')
        .replace(/-/g, ' ');
}

// ── Process one leaderboard file ─────────────────────────────────────────────

function processLeaderboard(filePath, preloaded) {
    let raw;
    if (preloaded) {
        raw = preloaded;
    } else {
        try { raw = JSON.parse(readFileSync(filePath, 'utf8')); }
        catch { return {}; }
    }

    const results = raw.results || [];
    const byConfig = {};

    for (const r of results) {
        const name = r.engineConfigName;
        if (!byConfig[name]) byConfig[name] = [];
        byConfig[name].push(r);
    }

    // Per config: compute score + per-category breakdown + timing
    const configStats = {};
    for (const [name, items] of Object.entries(byConfig)) {
        const cats = {};
        let totalMs = 0;
        for (const r of items) {
            if (!cats[r.category]) cats[r.category] = { pass: 0, total: 0 };
            cats[r.category].total++;
            if (r.pass) cats[r.category].pass++;
            totalMs += r.duration || 0;
        }
        const overall = items.filter(r => r.pass).length / items.length;
        const categories = Object.fromEntries(
            Object.entries(cats).map(([c, v]) => [c, +( v.pass / v.total).toFixed(3)])
        );
        configStats[name] = {
            overall: +overall.toFixed(3),
            categories,
            avgTimeSeconds: +(totalMs / items.length / 1000).toFixed(1),
            testCount: items.length,
        };
    }

    return configStats;
}

// ── Aggregate best-per-alias ─────────────────────────────────────────────────

function bestPerAlias(configStats, targetAlias) {
    let best = null;
    for (const [name, stats] of Object.entries(configStats)) {
        const alias = findAlias(name);
        if (alias !== targetAlias) continue;
        if (!best || stats.overall > best.overall) {
            best = { ...stats, bestConfig: name };
        }
    }
    return best;
}

// ── Build output ─────────────────────────────────────────────────────────────

// ── Merge community submissions ───────────────────────────────────────────────

function mergeResults(base, communityDir) {
    const merged = { ...base };
    try {
        for (const f of readdirSync(communityDir)) {
            if (!f.endsWith('.json') || f.endsWith('.meta.json')) continue;
            try {
                const raw = JSON.parse(readFileSync(join(communityDir, f), 'utf8'));
                const metaPath = join(communityDir, f.replace('.json', '.meta.json'));
                const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
                // Annotate each result with community metadata
                (raw.results || []).forEach(r => {
                    r._community = meta;
                });
                merged.results = [...(merged.results || []), ...(raw.results || [])];
                console.log(`  + community: ${f} (${raw.results?.length ?? 0} results)`);
            } catch (e) {
                console.warn(`  ! skipping ${f}: ${e.message}`);
            }
        }
    } catch { /* no community-results dir */ }
    return merged;
}

import { existsSync } from 'fs';

const LEADERBOARD_FILES = {
    cld: join(ROOT, 'evals/results/leaderboard_cld_full_results.json'),
    discuss: join(ROOT, 'evals/results/leaderboard_discuss_full_results.json'),
};
const COMMUNITY_DIR = join(ROOT, 'community-results');

console.log('Processing CLD results…');
const rawCld = JSON.parse(readFileSync(LEADERBOARD_FILES.cld, 'utf8'));
const mergedCld = mergeResults(rawCld, COMMUNITY_DIR);
const cldStats = processLeaderboard(null, mergedCld);

console.log('Processing Discussion results…');
const rawDiscuss = JSON.parse(readFileSync(LEADERBOARD_FILES.discuss, 'utf8'));
const mergedDiscuss = mergeResults(rawDiscuss, COMMUNITY_DIR);
const discussStats = processLeaderboard(null, mergedDiscuss);

// Collect cloud configs (no matching profile)
const allConfigNames = new Set([...Object.keys(cldStats), ...Object.keys(discussStats)]);

// Build model entries
const modelMap = {};

// Local models from profiles
for (const [alias, profile] of Object.entries(profiles)) {
    const cld = bestPerAlias(cldStats, alias);
    const discuss = bestPerAlias(discussStats, alias);
    if (!cld && !discuss) continue; // no results yet

    // Pick contributor metadata from community meta if present
    const sampleResult = (mergedCld.results || mergedDiscuss.results || [])
        .find(r => r.engineConfigName && findAlias(r.engineConfigName) === alias);
    const communityMeta = sampleResult?._community;

    modelMap[alias] = {
        alias,
        family: modelFamilyName(alias),
        quantization: profile.quantization || '',
        parameters: profile.parameterCount || '',
        backend: backendLabel(profile),
        contextLoaded: profile.contextLoaded || null,
        type: 'local',
        contributor: communityMeta?.contributor || 'tleitch',
        hardware: communityMeta?.hardware || 'Mac Studio M3 Ultra 512GB',
        cld: cld || null,
        discuss: discuss || null,
    };
}

// Cloud models (configs without a matching profile)
const cloudConfigs = {};
for (const name of allConfigNames) {
    if (findAlias(name)) continue; // has a local profile
    if (!inferCloudFromConfig(name)) continue;
    // Derive a display name from the config
    const parts = name.split('-');
    // e.g. qualitative-gemini-2.5-flash → "gemini-2.5-flash"
    const enginePrefixes = ['qualitative-zero', 'qualitative', 'causal-chains', 'causal-decoder', 'recursivecausal'];
    let model = name;
    for (const p of enginePrefixes.sort((a, b) => b.length - a.length)) {
        if (name.startsWith(p + '-')) { model = name.slice(p.length + 1); break; }
    }
    if (!cloudConfigs[model]) cloudConfigs[model] = { cldConfigs: [], discussConfigs: [] };
    if (cldStats[name]) cloudConfigs[model].cldConfigs.push({ name, ...cldStats[name] });
    if (discussStats[name]) cloudConfigs[model].discussConfigs.push({ name, ...discussStats[name] });
}

for (const [model, data] of Object.entries(cloudConfigs)) {
    const bestCld = data.cldConfigs.sort((a, b) => b.overall - a.overall)[0] || null;
    const bestDisc = data.discussConfigs.sort((a, b) => b.overall - a.overall)[0] || null;
    modelMap['cloud-' + model] = {
        alias: model,
        family: model.replace(/-/g, ' '),
        quantization: 'cloud API',
        parameters: '',
        backend: 'cloud API',
        contextLoaded: null,
        type: 'cloud',
        contributor: 'tleitch',
        hardware: '',
        cld: bestCld ? { overall: bestCld.overall, categories: bestCld.categories, avgTimeSeconds: bestCld.avgTimeSeconds, testCount: bestCld.testCount, bestConfig: bestCld.name } : null,
        discuss: bestDisc ? { overall: bestDisc.overall, categories: bestDisc.categories, avgTimeSeconds: bestDisc.avgTimeSeconds, testCount: bestDisc.testCount, bestConfig: bestDisc.name } : null,
    };
}

const models = Object.values(modelMap).sort((a, b) => {
    const aScore = (a.cld?.overall ?? a.discuss?.overall ?? 0);
    const bScore = (b.cld?.overall ?? b.discuss?.overall ?? 0);
    return bScore - aScore;
});

// Derive category list from results
const cldCategories = [...new Set(Object.values(cldStats).flatMap(s => Object.keys(s.categories)))].sort();
const discussCategories = [...new Set(Object.values(discussStats).flatMap(s => Object.keys(s.categories)))].sort();

const output = {
    generated: new Date().toISOString().split('T')[0],
    categories: { cld: cldCategories, discuss: discussCategories },
    models,
};

const outPath = join(__dirname, 'data/leaderboard.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Written ${models.length} models to ${outPath}`);
console.log(`  Local: ${models.filter(m => m.type === 'local').length}`);
console.log(`  Cloud: ${models.filter(m => m.type === 'cloud').length}`);
