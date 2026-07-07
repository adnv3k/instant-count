import * as vscode from 'vscode';

// Track last selection for instant gutter badge updates ---
let lastSelectionKey = '';
let lastSelectionText = '';

let statusBar: vscode.StatusBarItem;

// Store user's custom transformation rules
let customTransformRules: string | null = null;

// SVG decoration cache keyed by global occurrence number
const badgeCache: Map<number, vscode.TextEditorDecorationType> = new Map();

// Decorations currently rendered in the active editor 
const activeDecorations: Map<vscode.TextEditorDecorationType, boolean> = new Map();
// A match range paired with its 1-based global occurrence number
interface CountedMatch { range: vscode.Range; occ: number }
let cachedAllMatches: CountedMatch[] = [];
// Set before programmatic selection changes (navigation, select-all) so the
// selection listener doesn't reset the active pattern/count.
let programmaticSelectionGuard = false;
let cachedSearchPattern: string | null = null;
// Multipoint peek-view pattern preservation
let preservedMultipointPattern:
	| { searchPattern: string; searchDisplayText: string; isRegexPattern: boolean }
	| null = null;

// Simple cancellation token – increment to abort any in-flight scan 
let scanToken = 0;
// Full experience (regex rules, whole-word) up to these limits...
const FULL_FEATURE_BYTES = 10 * 1024 * 1024;
const FULL_FEATURE_LINES = 100_000;
// ...then a literal-only large-file mode up to this hard ceiling.
const LARGE_FILE_BYTES = 50 * 1024 * 1024;
// Watchdog for all regex scans.
const REGEX_TIMEOUT_MS = 1000;


// Helper: cross-platform requestAnimationFrame fallback for VS Code/Electron/Node
function requestAnimationFramePolyfill(cb: () => void) {
	if (typeof globalThis !== 'undefined') {
		if (typeof (globalThis as any).requestAnimationFrame === 'function') {
			(globalThis as any).requestAnimationFrame(cb);
			return;
		}
		if (typeof (globalThis as any).window !== 'undefined' && typeof (globalThis as any).window.requestAnimationFrame === 'function') {
			(globalThis as any).window.requestAnimationFrame(cb);
			return;
		}
	}
	setImmediate(cb);
}

// Load regex rules from configuration on activation
function loadRegexRulesFromConfig() {
	const config = vscode.workspace.getConfiguration('instant-count');
	const savedRules = config.get<string>('regexRules', '');
	if (savedRules && savedRules.trim().length > 0) {
		customTransformRules = savedRules;
	}
}

// Gated debug logging - enable with the "instant-count.debug" setting
function dbg(...args: unknown[]) {
	if (vscode.workspace.getConfiguration('instant-count').get<boolean>('debug', false)) {
		console.log('[instant-count]', ...args);
	}
}

// Save regex rules to configuration
async function saveRegexRulesToConfig(rules: string | null) {
	const config = vscode.workspace.getConfiguration('instant-count');
	await config.update('regexRules', rules || '', vscode.ConfigurationTarget.Global);
}

function debounce(fn: (...args: any[]) => void, delay: number) {
	let timeoutId: NodeJS.Timeout | null = null;
	return (...args: any[]) => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		timeoutId = setTimeout(() => {
			fn(...args);
		}, delay);
	};
}

// Helper function to sanitize text for display (handles quotes and special characters)
function sanitizeDisplayText(text: string): string {
	if (!text || typeof text !== 'string') {
		return '';
	}
	// Replace problematic characters for display
	return text
		.replace(/[\u201C\u201D"]/g, "'")  // Straight/curly double quotes -> apostrophe
		.replace(/[\u2018\u2019]/g, "'")  // Curly single quotes -> apostrophe
		.replace(/\r?\n/g, ' ')  // Replace newlines with spaces
		.replace(/\t/g, ' ')     // Replace tabs with spaces
		.replace(/\s+/g, ' ')    // Collapse multiple spaces
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')  // Remove C0 + DEL + C1
		.trim()
		.substring(0, 200); // Limit length to prevent overly long tooltips
}

// Stream literal matches, yielding periodically. Positions are resolved only
// for matches near the visible window (winStartOff..winEndOff, char offsets).
async function streamLiteralMatches(
	ed: vscode.TextEditor, text: string, needle: string,
	winStartOff: number, winEndOff: number, myToken: number
): Promise<{ total: number; windowMatches: CountedMatch[] }> {

	if (!needle) return { total: 0, windowMatches: [] };

	const config = vscode.workspace.getConfiguration('instant-count');
	const caseSensitive = config.get<boolean>('caseSensitive', false);

	const needleToSearch = caseSensitive ? needle : needle.toLowerCase();
	const textToSearch = caseSensitive ? text : text.toLowerCase();
	const windowMatches: CountedMatch[] = [];

	const len = textToSearch.length;
	const chunkChars = 100_000;                   // yield roughly every 100k chars scanned
	let total = 0;
	let idx = 0;
	let nextYieldAt = chunkChars;

	while (idx < len) {
		if (myToken !== scanToken) return { total: -1, windowMatches: [] }; // cancelled

		const pos = textToSearch.indexOf(needleToSearch, idx);
		if (pos === -1) break;
		total++;

		if (pos <= winEndOff && pos + needle.length >= winStartOff) {
			const startPos = ed.document.positionAt(pos);
			const endPos = ed.document.positionAt(pos + needle.length);
			windowMatches.push({ range: new vscode.Range(startPos, endPos), occ: total });
		}
		idx = pos + (needle.length || 1);

		// Yield after processing chunkChars
		if (idx >= nextYieldAt) {
			await new Promise<void>(resolve => requestAnimationFramePolyfill(resolve));
			nextYieldAt = idx + chunkChars;
		}
	}
	return { total, windowMatches };
}
// Stream regex matches with a watchdog. Returns total = -1 if superseded by a
// newer scan, -2 if the watchdog fired (likely catastrophic backtracking).
async function streamRegexMatches(
	editor: vscode.TextEditor, text: string, rx: RegExp,
	winStartOff: number, winEndOff: number,
	myToken: number, timeoutMs = REGEX_TIMEOUT_MS
): Promise<{ total: number; windowMatches: CountedMatch[] }> {

	const safe = rx.global ? rx : new RegExp(rx.source, rx.flags + 'g');
	safe.lastIndex = 0;
	const start = Date.now();
	const windowMatches: CountedMatch[] = [];
	let total = 0; let m: RegExpExecArray | null;
	let yieldCounter = 0;

	while ((m = safe.exec(text)) !== null) {
		if (myToken !== scanToken) return { total: -1, windowMatches: [] }; // cancelled
		total++; yieldCounter++;

		if (m.index <= winEndOff && m.index + m[0].length >= winStartOff) {
			const p = editor.document.positionAt(m.index);
			const e = editor.document.positionAt(m.index + m[0].length);
			windowMatches.push({ range: new vscode.Range(p, e), occ: total });
		}

		// Guard: a zero-length match would otherwise never advance lastIndex
		if (m[0].length === 0) safe.lastIndex++;

		if (yieldCounter >= 500) {                                 // yield every 500 hits
			yieldCounter = 0;
			await new Promise<void>(resolve => requestAnimationFramePolyfill(resolve));
		}
		if (Date.now() - start > timeoutMs) return { total: -2, windowMatches: [] }; // timed out
	}
	return { total, windowMatches };
}
// Process matches asynchronously to avoid blocking the main thread
export function activate(context: vscode.ExtensionContext) {
	// Load saved regex rules from configuration
	loadRegexRulesFromConfig();

	// Create status bar item
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'instant-count.showConfigPanel';
	context.subscriptions.push(statusBar);

	// --- Separate debounced functions for different update types ---
	const debouncedScrollUpdate = debounce(() => void updateCounts(), 100); // Longer delay for scroll
	const debouncedTextUpdate = debounce(() => void updateCounts(), 50);

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(e => {
			const ed = e.textEditor;
			if (!ed) return;

			const key = ed.selections
				.map(sel => `${sel.start.line},${sel.end.line}`)
				.join('|');
			const txt = ed.selections.map(sel => ed.document.getText(sel)).join('|');

			if (programmaticSelectionGuard) {
				// Selection was set by Instant Count itself (navigation / select-all):
				// keep the current pattern and count pinned.
				programmaticSelectionGuard = false;
				lastSelectionKey = key;
				lastSelectionText = txt;
				return;
			}

			if (key !== lastSelectionKey || txt !== lastSelectionText) {
				lastSelectionKey = key;
				lastSelectionText = txt;
				clearAllDecorations();
				// Reset buffer state on selection change
				currentBufferState = { startLine: -1, endLine: -1, searchPattern: '', activeLines: new Set() };
				preservedMultipointPattern = null;
				void updateCounts(); // Immediate for selection changes
			}
		}),
		vscode.window.onDidChangeActiveTextEditor(() => {
			lastSelectionKey = lastSelectionText = '';
			preservedMultipointPattern = null;
			clearAllDecorations();
			void updateCounts(); // Immediate for editor changes
		}),
		// Use longer debounce for scroll to reduce flicker
		vscode.window.onDidChangeTextEditorVisibleRanges(() => debouncedScrollUpdate()),
		vscode.workspace.onDidChangeTextDocument(() => debouncedTextUpdate()),
		vscode.window.onDidChangeActiveColorTheme(() => {
			// Badge SVGs bake in theme colors - rebuild them for the new theme
			clearAllDecorations();
			void disposeDecorationsAsync();
			currentBufferState = { startLine: -1, endLine: -1, searchPattern: '', activeLines: new Set() };
			debouncedTextUpdate();
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('instant-count.regexRules')) {
				loadRegexRulesFromConfig();
				clearAllDecorations();
				debouncedTextUpdate();
			}
		})
	);

	// Register async commands (Full original list)
	context.subscriptions.push(
		vscode.commands.registerCommand('instant-count.toggleCase', async () => await toggleCaseSensitive()),
		vscode.commands.registerCommand('instant-count.toggleWholeWord', async () => await toggleWholeWord()),
		vscode.commands.registerCommand('instant-count.toggleRegex', async () => await toggleRegexMode()),
		vscode.commands.registerCommand('instant-count.toggleGutterBadges', async () => await toggleGutterBadges()),
		vscode.commands.registerCommand('instant-count.toggleStatusBar', async () => await toggleStatusBar()),
		vscode.commands.registerCommand('instant-count.enterRegex', enterRegexPattern),
		vscode.commands.registerCommand('instant-count.clearRegex', async () => await clearCustomRegex()),
		vscode.commands.registerCommand('instant-count.cycleMode', async () => await cycleModes()),
		vscode.commands.registerCommand('instant-count.showConfigPanel', showConfigPanel),
		vscode.commands.registerCommand('instant-count.selectAll', async () => await selectAllOccurrences()),
		vscode.commands.registerCommand('instant-count.peekAll', async () => await peekAllOccurrences()),
		vscode.commands.registerCommand('instant-count.nextMatch', async () => await navigateMatch(1)),
		vscode.commands.registerCommand('instant-count.prevMatch', async () => await navigateMatch(-1))
	);

	// Initial async update
	void setImmediate(() => updateCounts());
}


export function deactivate() {
	clearAllDecorations();
	// Dispose decorations asynchronously in chunks to prevent blocking
	void disposeDecorationsAsync();
	statusBar?.dispose();
}

// Async disposal of decorations to prevent blocking on large files
async function disposeDecorationsAsync() {
	const decorations = Array.from(badgeCache.values());
	badgeCache.clear();

	const chunkSize = 50; // Dispose 50 decorations at a time
	for (let i = 0; i < decorations.length; i += chunkSize) {
		const chunk = decorations.slice(i, i + chunkSize);

		// Dispose chunk
		chunk.forEach(dec => {
			try {
				dec.dispose();
			} catch {
				// Ignore disposal errors
			}
		});

		// Yield control after each chunk
		if (i + chunkSize < decorations.length) {
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	}
}

// Helper function to clear all active decorations
function clearAllDecorations() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	for (const deco of activeDecorations.keys()) {
		try {
			editor.setDecorations(deco, []);
		} catch {/* ignore */ }
	}
	activeDecorations.clear();
}

function formatWhitespaceForMarkdown(t: string) {
	return t.replace(/\t/g, '→').replace(/\r?\n/g, '↵\n');
}


async function updateCounts() {
	const myToken = ++scanToken;

	try {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			statusBar.hide();
			return;
		}

		const cfg = vscode.workspace.getConfiguration('instant-count');
		if (!cfg.get<boolean>('showInStatusBar', true)) {
			statusBar.hide();
			return;
		}

		const doc = editor.document;
		const docSize = doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end);

		const searchInfo = getSearchPattern(editor);
		if (!searchInfo) {
			statusBar.text = '$(search)';
			statusBar.tooltip =
				'Instant Count: Select text or a word to count matches.\nClick to open settings.';
			statusBar.show();
			await updateGutterBadgesAsync(editor);
			return;
		}

		if (docSize > LARGE_FILE_BYTES) {
			statusBar.text = '$(warning)';
			statusBar.tooltip =
				`Instant Count paused - file is ${(docSize / (1024 * 1024)).toFixed(1)} MB ` +
				`(limit ${LARGE_FILE_BYTES / (1024 * 1024)} MB).`;
			statusBar.show();
			clearAllDecorations();
			return;
		}

		const oversized = docSize > FULL_FEATURE_BYTES || doc.lineCount > FULL_FEATURE_LINES;

		const text = doc.getText();
		const { renderStartLine, renderEndLine } = getRenderWindowLines(editor, 250);
		const winStartOff = doc.offsetAt(new vscode.Position(renderStartLine, 0));
		const winEndOff = doc.offsetAt(doc.lineAt(renderEndLine).range.end);

		if (oversized) {
			// Large-file mode: literal counting of the raw selection/word only.
			// Regex rules and whole-word are skipped to keep the scan cheap and safe.
			const needle = getRawNeedle(editor);
			if (!needle) {
				statusBar.text = '$(search)';
				statusBar.tooltip = 'Instant Count (large file): select text or a word to count literal matches.';
				statusBar.show();
				return;
			}
			const res = await streamLiteralMatches(editor, text, needle, winStartOff, winEndOff, myToken);
			if (res.total < 0) return; // superseded by a newer scan
			cachedAllMatches = res.windowMatches;
			cachedSearchPattern = `LARGE:${needle}`;
			statusBar.text = `$(search) ${res.total}`;
			const md = new vscode.MarkdownString(
				`**${res.total}** matches *(large file mode)*\n\n---\n\n` +
				'```\n' + formatWhitespaceForMarkdown(sanitizeDisplayText(needle)) + '\n```\n\n---\n\n' +
				'Large file: literal matching only - regex rules and whole-word are ignored. ' +
				'Badges cover the area around the viewport.'
			);
			statusBar.tooltip = md;
			statusBar.show();
			await updateGutterBadgesAsync(editor);
			return;
		}

		const useRegex = cfg.get<boolean>('useRegex', false);
		const regexIcon = useRegex ? '$(regex)' : '$(search)';
		const needRegexScan = useRegex || searchInfo.isRegexPattern;
		const regex = buildRegex(searchInfo.searchPattern);

		// Full-document scan; decoration ranges are collected only around the viewport.
		let total = 0;

		if (needRegexScan) {
			const fullResult = await streamRegexMatches(editor, text, regex, winStartOff, winEndOff, myToken);
			if (fullResult.total === -1) return; // superseded by a newer scan
			if (fullResult.total === -2) {
				statusBar.text = `${regexIcon} $(warning)`;
				statusBar.tooltip =
					`Instant Count: regex scan timed out after ${REGEX_TIMEOUT_MS} ms. ` +
					'The pattern may backtrack catastrophically - try making it more specific.';
				statusBar.show();
				return;
			}
			cachedAllMatches = fullResult.windowMatches;
			total = fullResult.total;
		} else {
			const fullResult = await streamLiteralMatches(editor, text, searchInfo.searchPattern, winStartOff, winEndOff, myToken);
			if (fullResult.total === -1) return; // superseded by a newer scan
			cachedAllMatches = fullResult.windowMatches;
			total = fullResult.total;
		}

		cachedSearchPattern = searchInfo.searchPattern;

		statusBar.text = `${regexIcon} ${total}`;
		const nonEmptySelections = editor.selections.filter(sel => !sel.isEmpty);

		const isMultiSelect = nonEmptySelections.length > 1;
		const hasCustomRules = useRegex && customTransformRules;

		// Use our helper to make whitespace in the selection visible
		const formattedDisplayText = formatWhitespaceForMarkdown(searchInfo.searchDisplayText);

		// Build the Markdown tooltip - show rules if active, otherwise the search text
		let tooltipContent: string;
		if (hasCustomRules) {
			tooltipContent = `**${total}** matches found\n\`\`\`\n${customTransformRules}\n\`\`\``;
		} else {
			tooltipContent = `**${total}** matches found\n\n---\n\n\`\`\`\n${formattedDisplayText}\n\`\`\``;
		}

		tooltipContent += '\n\n---\n\n';

		if (searchInfo.isRegexPattern && !isMultiSelect) {
			tooltipContent += `\n\n**Regex**\n\n\`\`\`${regex.source}\`\`\`\n`;
		} else if (isMultiSelect) {
			tooltipContent += `\n\n**Sequential Regex**\n\n\`\`\`${regex.source}\`\`\`\n`;
		}

		const markdownTooltip = new vscode.MarkdownString(tooltipContent);
		markdownTooltip.isTrusted = true;
		statusBar.tooltip = markdownTooltip;
		statusBar.show();
		await updateGutterBadgesAsync(editor);
	} catch (err) {
		statusBar.text = '$(warning)';
		statusBar.tooltip = `Instant Count error: ${(err as Error).message}`;
		statusBar.show();
	}
}

// True when the file exceeds the full-feature limits (large-file mode applies)
function isOversized(doc: vscode.TextDocument): boolean {
	const size = doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end);
	return size > FULL_FEATURE_BYTES || doc.lineCount > FULL_FEATURE_LINES;
}

// Raw selection text or word under cursor, ignoring regex rules/whole-word
function getRawNeedle(editor: vscode.TextEditor): string | null {
	if (!editor.selection.isEmpty) {
		const t = editor.document.getText(editor.selection);
		if (t.trim()) return t;
	}
	const wr = editor.document.getWordRangeAtPosition(editor.selection.active);
	if (wr) {
		const w = editor.document.getText(wr);
		if (w.trim()) return w;
	}
	return null;
}


function getSearchPattern(
	editor: vscode.TextEditor
): { searchPattern: string; searchDisplayText: string; isRegexPattern: boolean } | null {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	const useRegex = cfg.get<boolean>('useRegex', false);

	// Keep multipoint pattern if set by peek view
	if (preservedMultipointPattern) return preservedMultipointPattern;

	// Helper to create search pattern result
	const createSearchResult = (
		pattern: string, 
		displayText: string, 
		isRegex: boolean
	) => ({
		searchPattern: pattern,
		searchDisplayText: sanitizeDisplayText(displayText),
		isRegexPattern: isRegex,
	});

	// Helper to maybe apply rules
	const applyRules = (txt: string) => {
		if (!customTransformRules || !useRegex) return escapeRegex(txt);
		const p = customTransformRules.replace(/\$TEXT/g, escapeRegex(txt)).replace(/\$RAWTEXT/g, txt);
		return p;
	};

	// 1. Multi-selection → sequential regex
	const sels = editor.selections
		.map(sel => editor.document.getText(sel).trim())
		.filter(Boolean);
	if (sels.length > 1) {
		const pattern = sels
			.map(s => (useRegex && customTransformRules ? applyRules(s) : escapeRegex(s)))
			.join('.*?');
		return createSearchResult(pattern, sels.map(() => '$TEXT').join('.*?'), true);
	}

	// 2. Single selection
	if (!editor.selection.isEmpty) {
		const txt = editor.document.getText(editor.selection);
		if (txt.trim()) {
			if (useRegex && customTransformRules) {
				return createSearchResult(applyRules(txt), txt, true);
			}
			// Honor whole-word for selections: add \b only where the selection edge
			// is a word character, so punctuation/whitespace edges behave sensibly.
			if (cfg.get<boolean>('wholeWord', false)) {
				const prefix = /^\w/.test(txt) ? '\\b' : '';
				const suffix = /\w$/.test(txt) ? '\\b' : '';
				if (prefix || suffix) {
					return createSearchResult(`${prefix}${escapeRegex(txt)}${suffix}`, txt, true);
				}
			}
			// For literal matching, use the raw text without escaping
			return createSearchResult(txt, txt, false);
		}
	}

	// 3. Word under cursor
	const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
	if (wordRange) {
		const word = editor.document.getText(wordRange);
		if (word.trim()) {
			const ww = cfg.get<boolean>('wholeWord', false);
			if (useRegex && customTransformRules) {
				const p = applyRules(word);
				return createSearchResult(ww ? `\\b${p}\\b` : p, word, true);
			}
			// For word matching, we need regex when whole word is enabled
			if (ww) {
				return createSearchResult(`\\b${escapeRegex(word)}\\b`, word, true);
			} else {
				// For simple word matching without whole word, use literal matching
				return createSearchResult(word, word, false);
			}
		}
	}
	return null;
}

function buildRegex(pattern: string) {
	const config = vscode.workspace.getConfiguration('instant-count');
	const caseSensitive = config.get<boolean>('caseSensitive', false);
	const flags = caseSensitive ? 'gms' : 'gims';

	// Add safety checks for pattern
	if (!pattern || pattern.length === 0) {
		throw new Error('Empty pattern provided');
	}

	// Add performance safeguard for extremely long patterns
	const maxPatternLength = 5000;
	if (pattern.length > maxPatternLength) {
		throw new Error(`Pattern too long (max ${maxPatternLength} characters)`);
	}

	try {
		const regex = new RegExp(pattern, flags);

		// Test the regex with a simple string to catch some edge cases
		regex.test('test');

		return regex;
	} catch (error) {
		// Fallback for invalid regex - show error and escape everything
		console.warn(`Instant Count: Invalid regex pattern "${pattern}": ${error}`);
		return new RegExp(escapeRegex(pattern), flags);
	}
}

function escapeRegex(text: string) {
	return (text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Run a regex over the FULL text with periodic yields and a watchdog.
// Unlike a chunked scan, this never misses matches that span chunk boundaries.
async function runRegexWithTimeout(
	text: string,
	regex: RegExp,
	timeoutMs = REGEX_TIMEOUT_MS
): Promise<RegExpMatchArray[] | null> {
	const safe = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
	safe.lastIndex = 0;
	const start = Date.now();
	const matches: RegExpMatchArray[] = [];
	let sinceYield = 0;
	try {
		let m: RegExpExecArray | null;
		while ((m = safe.exec(text)) !== null) {
			matches.push(m);
			if (m[0].length === 0) safe.lastIndex++; // zero-length guard
			if (Date.now() - start > timeoutMs) return null;
			if (++sinceYield >= 500) {
				sinceYield = 0;
				await new Promise<void>(resolve => requestAnimationFramePolyfill(resolve));
			}
		}
	} catch {
		return null;
	}
	return matches;
}
async function toggleCaseSensitive() {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	await cfg.update('caseSensitive', !cfg.get<boolean>('caseSensitive', false), vscode.ConfigurationTarget.Global);
	await updateCounts();
}
async function toggleWholeWord() {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	await cfg.update('wholeWord', !cfg.get<boolean>('wholeWord', false), vscode.ConfigurationTarget.Global);
	await updateCounts();
}
async function toggleRegexMode() {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	await cfg.update('useRegex', !cfg.get<boolean>('useRegex', false), vscode.ConfigurationTarget.Global);
	await updateCounts();
}
async function toggleGutterBadges() {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	await cfg.update('showGutterBadges', !cfg.get<boolean>('showGutterBadges', true), vscode.ConfigurationTarget.Global);
	await updateCounts();
}
async function toggleStatusBar() {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	await cfg.update('showInStatusBar', !cfg.get<boolean>('showInStatusBar', true), vscode.ConfigurationTarget.Global);
	await updateCounts();
}

async function cycleModes() {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	const cs = cfg.get<boolean>('caseSensitive', false);
	const ww = cfg.get<boolean>('wholeWord', false);
	const rx = cfg.get<boolean>('useRegex', false);
	if (!cs && !ww && !rx) await cfg.update('caseSensitive', true, vscode.ConfigurationTarget.Global);
	else if (cs && !ww && !rx) {
		await cfg.update('caseSensitive', false, vscode.ConfigurationTarget.Global);
		await cfg.update('wholeWord', true, vscode.ConfigurationTarget.Global);
	} else if (!cs && ww && !rx) {
		await cfg.update('wholeWord', false, vscode.ConfigurationTarget.Global);
		await cfg.update('useRegex', true, vscode.ConfigurationTarget.Global);
	} else {
		await cfg.update('caseSensitive', false, vscode.ConfigurationTarget.Global);
		await cfg.update('wholeWord', false, vscode.ConfigurationTarget.Global);
		await cfg.update('useRegex', false, vscode.ConfigurationTarget.Global);
	}
	await updateCounts();
}

async function enterRegexPattern() {
	const pattern = await vscode.window.showInputBox({
		prompt: 'Enter regex rules to transform highlighted text',
		placeHolder: '\\b$TEXT\\b   or   $RAWTEXT+',
		value: customTransformRules || '',
		validateInput: v => {
			if (!v) return 'Rules cannot be empty';
			if (!v.includes('$TEXT') && !v.includes('$RAWTEXT'))
				return 'Must include $TEXT or $RAWTEXT placeholder';
			try {
				new RegExp(v.replace(/\$TEXT|\$RAWTEXT/g, 'test'), 'g');
				return null;
			} catch {
				return 'Invalid regex';
			}
		},
	});
	if (!pattern) return;
	clearAllDecorations();
	customTransformRules = pattern;
	await saveRegexRulesToConfig(pattern);
	const cfg = vscode.workspace.getConfiguration('instant-count');
	await cfg.update('useRegex', true, vscode.ConfigurationTarget.Global);
	await updateCounts();
}

async function showConfigPanel() {
	// Actions that open other UI (input box, peek, selection) dismiss the panel;
	// simple toggles refresh it in place.
	const dismissingActions = new Set(['enterRegex', 'peekAll', 'selectAll']);

	const getConfigItems = async () => {
		// Force reload regex rules from config
		loadRegexRulesFromConfig();

		const config = vscode.workspace.getConfiguration('instant-count');
		const caseSensitive = config.get<boolean>('caseSensitive', false);
		const wholeWord = config.get<boolean>('wholeWord', false);
		const useRegex = config.get<boolean>('useRegex', false);
		const showGutterBadges = config.get<boolean>('showGutterBadges', true);
		const showInStatusBar = config.get<boolean>('showInStatusBar', true);

		dbg('config panel values', { caseSensitive, wholeWord, useRegex, showGutterBadges, showInStatusBar, customTransformRules });

		return [
			{
				label: '$(case-sensitive) Case Sensitive',
				description: caseSensitive ? '✓ Enabled' : '○ Disabled',
				detail: 'Toggle case-sensitive matching',
				action: 'toggleCase'
			},
			{
				label: '$(whole-word) Whole Word',
				description: wholeWord ? '✓ Enabled' : '○ Disabled',
				detail: 'Match complete words only',
				action: 'toggleWholeWord'
			}, {
				label: '$(regex) Regex Mode',
				description: useRegex ? (customTransformRules ? '✓ Enabled (with rules)' : '✓ Enabled') : '○ Disabled',
				detail: 'Treat search patterns as regular expressions',
				action: 'toggleRegex'
			},
			{
				label: '$(bookmark) Gutter Badges',
				description: showGutterBadges ? '✓ Enabled' : '○ Disabled',
				detail: 'Show match numbers in editor gutter',
				action: 'toggleGutterBadges'
			},
			{
				label: '$(eye) Status Bar',
				description: showInStatusBar ? '✓ Enabled' : '○ Disabled',
				detail: 'Display count in status bar',
				action: 'toggleStatusBar'
			},
			{
				label: '',
				kind: vscode.QuickPickItemKind.Separator
			}, {
				label: '$(pencil) Enter Regex Rules',
				description: customTransformRules ? `Rules: ${customTransformRules.substring(0, 30)}${customTransformRules.length > 30 ? '...' : ''}` : 'No rules defined',
				detail: `Define regex rules to transform highlighted text${customTransformRules ? ' (Current rules active)' : ''} (Ctrl+Shift+Alt+R)`,
				action: 'enterRegex'
			},
			{
				label: '$(trash) Clear Custom Rules',
				description: customTransformRules ? 'Remove stored rules' : 'No rules to clear',
				detail: 'Clear the stored custom regex rules',
				action: 'clearRegex'
			},
			{
				label: '$(eye) Peek All Matches',
				description: 'View in peek panel',
				detail: 'Show all matches in peek view (Ctrl+Shift+Alt+P)',
				action: 'peekAll'
			},
			{
				label: '$(selection) Select All Matches',
				description: 'Multi-cursor selection',
				detail: 'Select all occurrences for editing (Ctrl+Shift+Alt+S)',
				action: 'selectAll'
			},
			{
				label: '$(arrow-right) Go to Next / Previous Match',
				description: 'Ctrl+Shift+Alt+. / Ctrl+Shift+Alt+,',
				detail: 'Jump between matches without touching the Find widget',
				action: 'nextMatch'
			}
		];
	};

	const quickPick = vscode.window.createQuickPick();
	let disposed = false;
	quickPick.items = await getConfigItems();
	quickPick.placeholder = 'Instant Count Configuration - Click to toggle settings';
	quickPick.title = 'Instant Count Settings (Ctrl+Shift+Alt+C)';
	quickPick.canSelectMany = false;
	// Keep the panel open while toggling settings and watching the count change;
	// Esc or picking a dismissing action closes it.
	quickPick.ignoreFocusOut = true;

	quickPick.onDidAccept(async () => {
		const selection = quickPick.selectedItems[0] as any;
		if (!selection || !selection.action) return;
		dbg('config panel action', selection.action);

		try {
			if (dismissingActions.has(selection.action)) {
				// These open other UI - close the panel first, then run them.
				quickPick.hide();
				await executeConfigAction(selection.action);
				return;
			}
			await executeConfigAction(selection.action);
			if (!disposed) {
				quickPick.items = await getConfigItems();
			}
		} catch (error) {
			console.error('Instant Count: config panel action failed:', error);
			void vscode.window.showErrorMessage(`Failed to execute action: ${selection.action}`);
		}
	});

	quickPick.onDidHide(() => {
		disposed = true;
		quickPick.dispose();
	});

	quickPick.show();
}

async function executeConfigAction(action: string) {
	dbg('executing config action:', action);

	try {
		switch (action) {
			case 'toggleCase':
				await vscode.commands.executeCommand('instant-count.toggleCase');
				break;
			case 'toggleWholeWord':
				await vscode.commands.executeCommand('instant-count.toggleWholeWord');
				break;
			case 'toggleRegex':
				await vscode.commands.executeCommand('instant-count.toggleRegex');
				break;
			case 'toggleGutterBadges':
				await vscode.commands.executeCommand('instant-count.toggleGutterBadges');
				break;
			case 'toggleStatusBar':
				await vscode.commands.executeCommand('instant-count.toggleStatusBar');
				break;
			case 'enterRegex':
				await vscode.commands.executeCommand('instant-count.enterRegex');
				break;
			case 'clearRegex':
				await vscode.commands.executeCommand('instant-count.clearRegex');
				break;
			case 'peekAll':
				await vscode.commands.executeCommand('instant-count.peekAll');
				break;
			case 'selectAll':
				await vscode.commands.executeCommand('instant-count.selectAll');
				break;
			case 'nextMatch':
				await vscode.commands.executeCommand('instant-count.nextMatch');
				break;
			default:
				console.warn('Unknown action:', action);
		}
		dbg('config action completed:', action);
	} catch (error) {
		console.error('Error executing config action:', action, error);
		throw error;
	}
}

async function selectAllOccurrences() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	if (isOversized(editor.document)) {
		void vscode.window.showInformationMessage('Instant Count: Select All is unavailable in large-file mode.');
		return;
	}
	const info = getSearchPattern(editor);
	if (!info) return;
	const matches = await processMatchesAsync(
		editor.document.getText(),
		buildRegex(info.searchPattern)
	);
	if (!matches.length) return;
	// Keep the current pattern/count pinned while we replace the selection
	programmaticSelectionGuard = true;
	editor.selections = matches.map(m => {
		const s = editor.document.positionAt(m.index!);
		const e = editor.document.positionAt(m.index! + m[0].length);
		return new vscode.Selection(s, e);
	});
}

async function peekAllOccurrences() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	if (isOversized(editor.document)) {
		void vscode.window.showInformationMessage('Instant Count: Peek All is unavailable in large-file mode.');
		return;
	}
	const info = getSearchPattern(editor);
	if (!info) return;
	const rx = buildRegex(info.searchPattern);
	const matches = await processMatchesAsync(editor.document.getText(), rx);
	if (!matches.length) return;
	const locs = matches.map(m => {
		const s = editor.document.positionAt(m.index!);
		const e = editor.document.positionAt(m.index! + m[0].length);
		return new vscode.Location(editor.document.uri, new vscode.Range(s, e));
	});
	await vscode.commands.executeCommand(
		'editor.action.peekLocations',
		editor.document.uri,
		editor.selection.active,
		locs,
		'peek',
		`${matches.length} matches`
	);
}

// Jump to the next/previous occurrence of the current pattern (wraps around).
// The selection is set programmatically so the active pattern/count stays pinned.
async function navigateMatch(direction: 1 | -1) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	if (isOversized(editor.document)) {
		void vscode.window.showInformationMessage('Instant Count: match navigation is unavailable in large-file mode.');
		return;
	}
	const info = getSearchPattern(editor);
	if (!info) return;
	const doc = editor.document;
	const matches = await processMatchesAsync(doc.getText(), buildRegex(info.searchPattern));
	if (!matches.length) return;

	const cursor = doc.offsetAt(editor.selection.active);
	let target: RegExpMatchArray | undefined;
	if (direction === 1) {
		target = matches.find(m => m.index! > cursor) ?? matches[0]; // wrap to first
	} else {
		for (let i = matches.length - 1; i >= 0; i--) {
			if (matches[i].index! + matches[i][0].length < cursor) { target = matches[i]; break; }
		}
		target = target ?? matches[matches.length - 1]; // wrap to last
	}

	const s = doc.positionAt(target.index!);
	const e = doc.positionAt(target.index! + target[0].length);
	programmaticSelectionGuard = true;
	editor.selection = new vscode.Selection(s, e);
	editor.revealRange(new vscode.Range(s, e), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// Clear saved rules
async function clearCustomRegex() {
	clearAllDecorations();
	customTransformRules = null;
	await saveRegexRulesToConfig(null);
	const cfg = vscode.workspace.getConfiguration('instant-count');
	await cfg.update('useRegex', false, vscode.ConfigurationTarget.Global);
	await updateCounts();
}

// Track buffer state for efficient updates
let currentBufferState = {
	startLine: -1,
	endLine: -1,
	searchPattern: '',
	activeLines: new Set<number>()
};

// Update getRenderWindowLines to use a smaller buffer for visible calculations
function getRenderWindowLines(
	editor: vscode.TextEditor,
	bufferLines = 50  // Reduced buffer for visible range calculation
): { renderStartLine: number; renderEndLine: number } {
	let minLine = Number.MAX_VALUE;
	let maxLine = -1;
	for (const vr of editor.visibleRanges) {
		minLine = Math.min(minLine, vr.start.line);
		maxLine = Math.max(maxLine, vr.end.line);
	}
	if (minLine === Number.MAX_VALUE) minLine = maxLine = 0;
	return {
		renderStartLine: Math.max(0, minLine - bufferLines),
		renderEndLine: Math.min(editor.document.lineCount - 1, maxLine + bufferLines),
	};
}

// Update gutter badges asynchronously with better performance
async function updateGutterBadgesAsync(
	editor: vscode.TextEditor
) {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	if (!cfg.get<boolean>('showGutterBadges', true)) {
		if (currentBufferState.activeLines.size > 0) {
			clearAllDecorations();
			currentBufferState = { startLine: -1, endLine: -1, searchPattern: '', activeLines: new Set() };
		}
		return;
	}

	const allMatches = cachedAllMatches;
	if (!allMatches.length) {
		if (currentBufferState.activeLines.size > 0) {
			clearAllDecorations();
			currentBufferState = { startLine: -1, endLine: -1, searchPattern: '', activeLines: new Set() };
		}
		return;
	}

	// Calculate buffer window (visible + 200 lines above/below)
	const { renderStartLine, renderEndLine } = getRenderWindowLines(editor);
	const bufferStartLine = Math.max(0, renderStartLine - 200);
	const bufferEndLine = Math.min(editor.document.lineCount - 1, renderEndLine + 200);

	// Check if we need to update based on buffer changes or pattern changes
	const patternChanged = cachedSearchPattern !== currentBufferState.searchPattern;
	const bufferMoved = bufferStartLine !== currentBufferState.startLine ||
		bufferEndLine !== currentBufferState.endLine;

	// Only update if buffer moved significantly or pattern changed
	if (!patternChanged && !bufferMoved) {
		return; // No changes needed
	}

	// Map each line to the global occurrence number of its first match
	const lineToGlobalOccurrence = new Map<number, number>();
	for (const cm of allMatches) {
		const lineNum = cm.range.start.line;
		if (!lineToGlobalOccurrence.has(lineNum)) {
			lineToGlobalOccurrence.set(lineNum, cm.occ);
		}
	}

	// Find lines that should have badges in the buffer window
	const newActiveLines = new Set<number>();
	const breakpoints = new Set(
		vscode.debug.breakpoints
			.filter(bp => bp instanceof vscode.SourceBreakpoint)
			.map(bp => (bp as vscode.SourceBreakpoint).location.range.start.line)
	);

	// Include all matches in buffer window
	for (const match of allMatches) {
		const lineNum = match.range.start.line;
		if (lineNum >= bufferStartLine && lineNum <= bufferEndLine &&
			!breakpoints.has(lineNum) && lineToGlobalOccurrence.has(lineNum)) {
			newActiveLines.add(lineNum);
		}
	}

	// Determine what needs to be cleared
	const linesToClear = new Set([...currentBufferState.activeLines].filter(line => !newActiveLines.has(line)));

	// Only clear specific decorations that are no longer needed
	if (linesToClear.size > 0 || patternChanged) {
		if (patternChanged) {
			// Pattern changed - clear everything
			clearAllDecorations();
		} else {
			// Only clear decorations for lines that are no longer in buffer
			for (const lineNum of linesToClear) {
				const globalOccurrence = lineToGlobalOccurrence.get(lineNum);
				if (globalOccurrence) {
					const badgeType = badgeCache.get(globalOccurrence);
					if (badgeType && activeDecorations.has(badgeType)) {
						editor.setDecorations(badgeType, []);
						activeDecorations.delete(badgeType);
					}
				}
			}
		}
	}

	// Apply decorations for the entire buffer window
	const newDecorationRanges = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();

	for (const lineNum of newActiveLines) {
		const globalOccurrence = lineToGlobalOccurrence.get(lineNum)!;

		let badgeType = badgeCache.get(globalOccurrence);
		if (!badgeType) {
			const gutterIcon = createNumberedBadgeSvg(globalOccurrence);
			badgeType = vscode.window.createTextEditorDecorationType({
				gutterIconPath: gutterIcon,
				gutterIconSize: 'contain',
			});
			badgeCache.set(globalOccurrence, badgeType);
		}

		if (!newDecorationRanges.has(badgeType)) {
			newDecorationRanges.set(badgeType, []);
		}
		newDecorationRanges.get(badgeType)!.push(new vscode.Range(lineNum, 0, lineNum, 0));
	}

	// Apply new decorations in batch
	newDecorationRanges.forEach((decorationRanges, decorationType) => {
		editor.setDecorations(decorationType, decorationRanges);
		activeDecorations.set(decorationType, true);
	});

	// Update buffer state
	currentBufferState = {
		startLine: bufferStartLine,
		endLine: bufferEndLine,
		searchPattern: cachedSearchPattern || '',
		activeLines: newActiveLines
	};
}

// Create an SVG badge for the gutter with the occurrence number.
// Colors are theme-aware (SVG gutter icons can't use CSS variables).
function createNumberedBadgeSvg(n: number) {
	const txt = n.toString();
	const w = Math.max(3, txt.length * 2.5 + 0.5);
	const kind = vscode.window.activeColorTheme.kind;
	const isLight =
		kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
	const fill = isLight ? '#444' : '#aaa';
	const opacity = isLight ? 0.5 : 0.35;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="8" viewBox="0 0 ${w} 8">
	<text x="${w / 2}" y="4.5" fill="${fill}" fill-opacity="${opacity}"
		font-size="5" font-family="system-ui,-apple-system,sans-serif"
		text-anchor="middle" dominant-baseline="middle">${txt}</text></svg>`;
	return vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent(svg)}`);
}

// Process matches asynchronously with chunked processing and timeout protection
async function processMatchesAsync(text: string, regex: RegExp): Promise<RegExpMatchArray[]> {
	// Use the timeout-protected function first
	const result = await processMatchesWithTimeout(text, regex, 1000); // 1 second timeout

	if (result !== null) {
		return result;
	}

	// If timeout occurred, fall back to basic processing for small texts only
	if (text.length < 10000) {
		try {
			return Array.from(text.matchAll(regex));
		} catch (error) {
			console.warn('Regex processing failed:', error);
			return [];
		}
	}

	// For large texts that timed out, return empty array
	return [];
}

// Wrapper for processMatchesAsync that uses runRegexWithTimeout for safety
async function processMatchesWithTimeout(text: string, regex: RegExp, timeoutMs: number = 500): Promise<RegExpMatchArray[]> {
	const result = await runRegexWithTimeout(text, regex, timeoutMs);
	if (result === null) {
		// Timeout or catastrophic backtracking detected
		void vscode.window.showWarningMessage(
			'Regex operation was aborted due to excessive processing time. ' +
			'This may be caused by catastrophic backtracking in your pattern. ' +
			'Try simplifying your regex or using more specific patterns.'
		);
		return [];
	}
	return result;
}
