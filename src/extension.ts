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
let cachedAllMatches: vscode.Range[] = [];
let cachedSearchPattern: string | null = null;
// Multipoint peek-view pattern preservation
let preservedMultipointPattern:
	| { searchPattern: string; searchDisplayText: string; isRegexPattern: boolean }
	| null = null;

// Simple cancellation token – increment to abort any in-flight scan 
let scanToken = 0;
const MAX_MB = 10 * 1024 * 1024;
const MAX_LINES = 100_000;


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
		.replace(/"/g, "'")  // Replace double quotes with single quotes
		.replace(/'/g, "'")  // Normalize single quotes
		.replace(/\r?\n/g, ' ')  // Replace newlines with spaces
		.replace(/\t/g, ' ')     // Replace tabs with spaces
		.replace(/\s+/g, ' ')    // Collapse multiple spaces
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')  // Remove C0 + DEL + C1
		.trim()
		.substring(0, 200); // Limit length to prevent overly long tooltips
}

// Stream literal matches with a timeout and yield mechanism
async function streamLiteralMatches(
	ed: vscode.TextEditor, text: string, needle: string,
	renderStartLine: number, renderEndLine: number, myToken: number
): Promise<{ total: number; windowMatches: vscode.Range[] }> {

	if (!needle) return { total: 0, windowMatches: [] };
	
	// Check if case sensitive mode is enabled
	const config = vscode.workspace.getConfiguration('instant-count');
	const caseSensitive = config.get<boolean>('caseSensitive', false);
	
	// Only convert to lowercase if case insensitive
	const needleToSearch = caseSensitive ? needle : needle.toLowerCase();
	const textToSearch = caseSensitive ? text : text.toLowerCase();
	const windowMatches: vscode.Range[] = [];

	const len = textToSearch.length;
	const chunkChars = 10_000;                    // scan ~100 kB per yield
	let total = 0;
	let idx = 0;
	let nextYieldAt = chunkChars;

	while (idx < len) {
		if (myToken !== scanToken) return { total: -1, windowMatches: [] }; // cancelled

		const pos = textToSearch.indexOf(needleToSearch, idx);
		if (pos === -1) break;
		total++;

		const startPos = ed.document.positionAt(pos);
		if (startPos.line >= renderStartLine && startPos.line <= renderEndLine) {
			const endPos = ed.document.positionAt(pos + needle.length);
			windowMatches.push(new vscode.Range(startPos, endPos));
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
// Stream regex matches with a timeout and yield mechanism
async function streamRegexMatches(
	editor: vscode.TextEditor, text: string, rx: RegExp,
	renderStartLine: number, renderEndLine: number,
	myToken: number, timeoutMs = 1000
): Promise<{ total: number; windowMatches: vscode.Range[] }> {

	const safe = rx.global ? rx : new RegExp(rx.source, rx.flags + 'g');
	const start = Date.now();
	const windowMatches: vscode.Range[] = [];
	let total = 0; let m: RegExpExecArray | null;
	let yieldCounter = 0;

	while ((m = safe.exec(text)) !== null) {
		if (myToken !== scanToken) return { total: -1, windowMatches: [] }; // cancelled
		total++; yieldCounter++;

		const p = editor.document.positionAt(m.index);
		if (p.line >= renderStartLine && p.line <= renderEndLine) {
			const e = editor.document.positionAt(m.index + m[0].length);
			windowMatches.push(new vscode.Range(p, e));
		}

		if (yieldCounter >= 500) {                                 // yield every 500 hits
			yieldCounter = 0;
			await new Promise<void>(resolve => requestAnimationFramePolyfill(resolve));
		}
		if (Date.now() - start > timeoutMs) return { total: -1, windowMatches: [] };
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
		vscode.commands.registerCommand('instant-count.peekAll', async () => await peekAllOccurrences())
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

		// const searchInfo = getSearchPattern(editor);		
		const searchInfo = await Promise.resolve(getSearchPattern(editor));

		if (editor.document.lineCount > MAX_LINES) {
			if (!searchInfo || !searchInfo.searchDisplayText.trim().length) {
				// File is huge *and* the user isn't highlighting anything.
				// Skip scan entirely to stay responsive.
				statusBar.text = '$(warning)';
				statusBar.tooltip =
					`Instant Count paused – ${editor.document.lineCount.toLocaleString()} lines.\n` +
					'Highlight text to count inside the selection, or reload the file.';
				statusBar.show(); await updateGutterBadgesAsync(editor); return;
			}
		}
		if (!searchInfo) {
			statusBar.text = '$(search)';
			statusBar.tooltip =
				'Instant Count: Select text or a word to count matches.\nClick to open settings.';
			statusBar.show();
			await updateGutterBadgesAsync(editor);
			return;
		}
		if (editor.document.getText().length > MAX_MB || editor.document.lineCount > MAX_LINES) {
			statusBar.text = '$(warning)';
			statusBar.tooltip = 'Instant Count disabled – file too large.';
			statusBar.show(); await updateGutterBadgesAsync(editor);
			return;
		}

		const text = editor.document.getText();
		// Bail on extremely large files
		if (text.length > 6 * 1024 * 1024) {
			statusBar.text = '$(warning)';
			statusBar.tooltip = 'Instant Count: File too large to process';
			statusBar.show();
			await updateGutterBadgesAsync(editor);
			return;
		}
		const useRegex = cfg.get<boolean>('useRegex', false);
		const regexIcon = useRegex ? '$(regex)' : '$(search)';
		const needRegexScan = useRegex || searchInfo.isRegexPattern;
		const regex = buildRegex(searchInfo.searchPattern);

		// Do FULL document scan once and cache results
		let total = 0;

		if (needRegexScan) {
			const fullResult = await streamRegexMatches(editor, text, regex, 0, editor.document.lineCount - 1, myToken);
			if (fullResult.total === -1) return;
			cachedAllMatches = fullResult.windowMatches;
			total = fullResult.total;


		} else {
			const fullResult = await streamLiteralMatches(editor, text, searchInfo.searchPattern, 0, editor.document.lineCount - 1, myToken);
			if (fullResult.total === -1) return;
			cachedAllMatches = fullResult.windowMatches;
			total = fullResult.total;
		}

		cachedSearchPattern = searchInfo.searchPattern;

		statusBar.text = `${regexIcon} ${total}`;
		const nonEmptySelections = editor.selections.filter(sel => !sel.isEmpty);

		const isMultiSelect = nonEmptySelections.length > 1;
		const hasCustomRules = useRegex && customTransformRules;

		// Use our new helper to make whitespace in the selection visible
		const formattedDisplayText = formatWhitespaceForMarkdown(searchInfo.searchDisplayText);
		// const regex = buildRegex(searchInfo.searchPattern);

		// Start building the Markdown content - show rules if active, otherwise show search text
		let tooltipContent: string;
		if (hasCustomRules) {
			tooltipContent = `**${total}** matches found\n\`\`\`\n${customTransformRules}\n\`\`\``;
		} else if (useRegex && !customTransformRules) {
			tooltipContent = `**${total}** matches found\n\n---\n\n\`\`\`\n${formattedDisplayText}\n\`\`\``;
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


function getSearchPattern(
	editor: vscode.TextEditor
): { searchPattern: string; searchDisplayText: string; isRegexPattern: boolean } | null {
	const cfg = vscode.workspace.getConfiguration('instant-count');
	const useRegex = cfg.get<boolean>('useRegex', false);

	// Keep multipoint pattern if set by peek view
	if (preservedMultipointPattern) return preservedMultipointPattern;

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
		return {
			searchPattern: pattern,
			searchDisplayText: sels.map(() => '$TEXT').join('.*?'),
			isRegexPattern: true,
		};
	}

	// 2. Single selection
	if (!editor.selection.isEmpty) {
		const txt = editor.document.getText(editor.selection);
		if (txt.trim()) {
			if (useRegex && customTransformRules) {
				return {
					searchPattern: applyRules(txt),
					searchDisplayText: sanitizeDisplayText(txt),
					isRegexPattern: true,
				};
			}
			// For literal matching, use the raw text without escaping
			return {
				searchPattern: txt,
				searchDisplayText: sanitizeDisplayText(txt),
				isRegexPattern: false,
			};
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
				return {
					searchPattern: ww ? `\\b${p}\\b` : p,
					searchDisplayText: sanitizeDisplayText(word),
					isRegexPattern: true,
				};
			}
			// For word matching, we need regex when whole word is enabled
			if (ww) {
				const p = `\\b${escapeRegex(word)}\\b`;
				return {
					searchPattern: p,
					searchDisplayText: sanitizeDisplayText(word),
					isRegexPattern: true,
				};
			} else {
				// For simple word matching without whole word, use literal matching
				return {
					searchPattern: word,
					searchDisplayText: sanitizeDisplayText(word),
					isRegexPattern: false,
				};
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

// Run a regex with a watchdog (still used by other commands)
async function runRegexWithTimeout(
	text: string,
	regex: RegExp,
	timeoutMs = 500
): Promise<RegExpMatchArray[] | null> {
	const safe = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
	return new Promise(resolve => {
		let finished = false;
		const matches: RegExpMatchArray[] = [];
		const start = Date.now();
		const chunkSize = 50000;
		let idx = 0;
		const run = () => {
			if (finished) return;
			if (Date.now() - start > timeoutMs) {
				finished = true;
				resolve(null);
				return;
			}
			const chunk = text.slice(idx, idx + chunkSize);
			try {
				const mAll = Array.from(chunk.matchAll(safe));
				mAll.forEach(m => {
					if (m.index != null) m.index += idx;
				});
				matches.push(...mAll);
			} catch {
				finished = true;
				resolve(null);
				return;
			}
			idx += chunkSize;
			if (idx < text.length) requestAnimationFramePolyfill(run);
			else {
				finished = true;
				resolve(matches);
			}
		};
		requestAnimationFramePolyfill(run);
	});
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
	// Function to get fresh configuration items with debugging
	const getConfigItems = async () => {
		// Force reload regex rules from config
		loadRegexRulesFromConfig();

		// Get fresh configuration instance
		const config = vscode.workspace.getConfiguration('instant-count');
		const caseSensitive = config.get<boolean>('caseSensitive', false);
		const wholeWord = config.get<boolean>('wholeWord', false);
		const useRegex = config.get<boolean>('useRegex', false);
		const showGutterBadges = config.get<boolean>('showGutterBadges', true);
		const showInStatusBar = config.get<boolean>('showInStatusBar', true);

		// Debug logging
		console.log('QuickPick - Config Values:', { caseSensitive, wholeWord, useRegex, showGutterBadges, showInStatusBar, customTransformRules });

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
				detail: 'Show all matches in peek view (Ctrl+Shift+3)',
				action: 'peekAll'
			},
			{
				label: '$(selection) Select All Matches',
				description: 'Multi-cursor selection',
				detail: 'Select all occurrences for editing (Ctrl+Shift+Alt+L)',
				action: 'selectAll'
			}
		];
	};

	// Create initial items
	const items = await getConfigItems();

	// Show interactive quick pick
	const quickPick = vscode.window.createQuickPick();
	quickPick.items = items;
	quickPick.placeholder = 'Instant Count Configuration - Click to toggle settings';
	quickPick.title = 'Instant Count Settings';
	quickPick.canSelectMany = false;
	quickPick.ignoreFocusOut = false;

	// Handle selection with robust refresh logic
	quickPick.onDidAccept(async () => {
		const selection = quickPick.selectedItems[0] as any;
		if (selection && selection.action) {
			console.log('QuickPick - Executing action:', selection.action);

			try {
				// Execute the action and wait for completion
				await executeConfigAction(selection.action);

				// Wait longer for configuration to propagate (VS Code can be slow)
				await new Promise(resolve => setTimeout(resolve, 50));

				// Force refresh with new config values
				const updatedItems = await getConfigItems();
				quickPick.items = updatedItems;

				console.log('QuickPick - Panel refreshed successfully');
			} catch (error) {
				console.error('QuickPick - Error executing action:', error);
				void vscode.window.showErrorMessage(`Failed to execute action: ${selection.action}`);
			}
		}
	});

	// Handle dismissal
	quickPick.onDidHide(() => {
		// wrap in trycatch to avoid errors if disposed
		try {
			// pass this line
			quickPick.dispose();

		} catch (error) {
			console.error('😭😭😭QuickPick - Error on dismiss:', error);
		}
	});

	quickPick.show();
}

async function executeConfigAction(action: string) {
	console.log('Executing config action:', action);

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
			default:
				console.warn('Unknown action:', action);
		}
		console.log('Config action completed:', action);
	} catch (error) {
		console.error('Error executing config action:', action, error);
		throw error;
	}
}

async function selectAllOccurrences() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const info = getSearchPattern(editor);
	if (!info) return;
	const matches = await processMatchesAsync(
		editor.document.getText(),
		buildRegex(info.searchPattern)
	);
	if (!matches.length) return;
	editor.selections = matches.map(m => {
		const s = editor.document.positionAt(m.index!);
		const e = editor.document.positionAt(m.index! + m[0].length);
		return new vscode.Selection(s, e);
	});
}

async function peekAllOccurrences() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
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

	// Create global occurrence mapping
	const lineToGlobalOccurrence = new Map<number, number>();
	for (let i = 0; i < allMatches.length; i++) {
		const lineNum = allMatches[i].start.line;
		if (!lineToGlobalOccurrence.has(lineNum)) {
			lineToGlobalOccurrence.set(lineNum, i + 1);
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
		const lineNum = match.start.line;
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

// Create an SVG badge for the gutter with the occurrence number
function createNumberedBadgeSvg(n: number) {
	const txt = n.toString();
	const w = Math.max(3, txt.length * 2.5 + 0.5);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="8" viewBox="0 0 ${w} 8">
	<text x="${w / 2}" y="4.5" fill="#aaa" fill-opacity="0.25"
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
