import { Ignore } from 'ignore';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';

import { ChildProcManager, ConnectionLogger, DelayedCaller, fsWriteFileSync, tmpFileManager, } from './genutils';
import { SystemVerilogIndexer } from './svindexer';
import { default_settings, } from './svutils';

let settings: Map<string, any> = default_settings;

const path = require('path');
const fs = require('fs');
const ignore = require('ignore');

type GetFileCbFilter = (file: string) => string;
type GetFileCbDone = (files: Array<string>) => void;

interface GetFileStat {
    dirPendingNum: number;
    fileList: Array<string>;
}
type GetFileOptions = {
    levelCur?: number;
    levelMax?: number;
    filePattern?: RegExp;
    fileType?: string;
    parentPath?: string;
    h_ignore?: Ignore;
}

function getFileList(dirPath: string, options: GetFileOptions = null, cb_each: GetFileCbFilter = null, cb_done: GetFileCbDone = null, stat: GetFileStat = null): void {
    let defaultOpitons = {
        levelCur: 0,
        levelMax: 1,
        filePattern: null,
        fileType: 'df',
        parentPath: '',
        h_ignore: ignore()
    };
    options = Object.assign({}, defaultOpitons, options);

    // ConnectionLogger.log(`DEBUG: dirPath = ${dirPath}`);
    if (stat == null) stat = { dirPendingNum: 1, fileList: [] };

    if (options.levelCur >= options.levelMax) {
        stat.dirPendingNum -= 1;
        if (stat.dirPendingNum == 0 && cb_done) cb_done(stat.fileList);
        return;
    }

    if (fs.existsSync(path.join(dirPath, '.gitignore'))) {
        options.h_ignore.add(
            fs.readFileSync(path.join(dirPath, '.gitignore'), 'utf8'));
    }
    fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
        if (err) files = [];

        files.forEach(file => {
            let filepath = path.join(dirPath, file.name);
            let ignoreRelPath = path.join(options.parentPath, file.name)

            if (options.filePattern != null) {
                if (file.name.match(options.filePattern) == null) return;
            }
            if (options.h_ignore != null) {
                if (options.h_ignore.ignores(ignoreRelPath)) {
                    // ConnectionLogger.log(`DEBUG: ignore = ${ignoreRelPath}`);
                    return;
                }
            }
            if (file.isDirectory() && options.levelCur + 1 < options.levelMax) {
                stat.dirPendingNum += 1;
                let sub_options = Object.assign({}, options, {
                    levelCur: options.levelCur + 1,
                    parentPath: ignoreRelPath
                })
                getFileList(filepath, sub_options, cb_each, cb_done, stat);
            }
            if (!(options.fileType.includes(file.isDirectory() ? 'd' : 'f')))
                return;

            if (cb_each) filepath = cb_each(filepath);
            if (filepath != null) stat.fileList.push(filepath)
        });
        stat.dirPendingNum -= 1;
        if (stat.dirPendingNum == 0 && cb_done) cb_done(stat.fileList);
    });
}

function getVerilatorSeverity(severityString: string):
    DiagnosticSeverity {
    let result: DiagnosticSeverity = DiagnosticSeverity.Information;

    if (severityString.startsWith('Error')) {
        result = DiagnosticSeverity.Error;
    } else if (severityString.startsWith('Warning')) {
        result = DiagnosticSeverity.Warning;
    }

    return result;
}

function parseVerilatorDiagnostics(
    stdout: string, stderr: string, file: string,
    whitelistedMessages: RegExp[] = []):
    Diagnostic[] {
    let diagnostics: Diagnostic[] = [];
    let lines = stderr.split(/\r?\n/g);

    // RegExp expression for matching Verilator messages
    // Group 1: Severity
    // Group 2: Type (optional)
    // Group 3: Filename
    // Group 4: Line number
    // Group 5: Column number (optional)
    // Group 6: Message

    if (settings.get('systemverilog.lintingVerilatorUseWSL')) {
        file = `/mnt/${file.replace(/:/, '')}`;
        // ConnectionLogger.log(`DEBUG: file ${file}`);
    }

    let regexCurFile: RegExp = new RegExp(
        String.raw`%(Error|Warning)(-[A-Z0-9_]+)?: (${file.replace(
            /[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}):(\d+):(?:(\d+):)? (.*)`,
        'i');
    let regexAllFile: RegExp = new RegExp(
        String.raw`%(Error|Warning)(-[A-Z0-9_]+)?: ([^:]+):(\d+):(?:(\d+):)? (.*)`, 'i');

    // ConnectionLogger.log(`verilator regex: ${file.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}`);
    // Parse output lines
    for (let i = 0; i < lines.length; ++i) {
        const line = lines[i];

        // let m = line.match(regexAllFile);
        // if (m != null) ConnectionLogger.log(`verilator: ${line}`);

        let terms = line.match(regexAllFile);
        if (terms != null) {
            let severity = getVerilatorSeverity(terms[1]);
            let message = '';
            let lineNum = parseInt(terms[4]) - 1;
            let colNum = 0;
            let colNumEnd = 0;
            if (terms[5]) {
                colNum = parseInt(terms[5]) - 1;
            }
            message = terms[6];

            ConnectionLogger.log(`verilator: ${line}`);

            let messageWhiteListed: Boolean = false;
            for (let whitelistedMessage of whitelistedMessages) {
                if (message.search(whitelistedMessage) >= 0) {
                    messageWhiteListed = true;
                    break;
                }
            }
            if (messageWhiteListed) {
                continue;
            }

            // Match the ^~~~~~~ under the error message
            if (/\s*\^~+/.exec(lines[i + 2])) {
                let startColNum: number = lines[i + 2].indexOf('|') + 2;
                colNum = lines[i + 2].indexOf('^');
                colNum = colNum > startColNum ? colNum - startColNum : colNum;
                colNumEnd = lines[i + 2].lastIndexOf('~');
                colNumEnd =
                    colNumEnd > startColNum ? colNumEnd - startColNum : colNumEnd;
                i += 2;
            }

            if ((lineNum != NaN) && (colNum != NaN)) {
                diagnostics.push({
                    severity: severity,
                    range: Range.create(
                        lineNum, colNum, lineNum,
                        colNumEnd < colNum ? colNum : colNumEnd),
                    message: message,
                    code: 'verilator',
                    source: terms[3] // attach file path on source 
                });
            }
        }
    }

    return diagnostics;
}

function getIcarusSeverity(severityString: string, message: string):
    DiagnosticSeverity {
    let result: DiagnosticSeverity = DiagnosticSeverity.Information;

    if (severityString === 'error' || message === 'syntax error') {
        result = DiagnosticSeverity.Error;
    } else if (severityString === 'warning') {
        result = DiagnosticSeverity.Warning;
    }

    return result;
}

function parseIcarusDiagnostics(
    stdout: string, stderr: string, file: string,
    whitelistedMessages: RegExp[] = []) {
    let diagnostics: Diagnostic[] = [];
    let lines = stderr.split(/\r?\n/g);

    // RegExp expression for matching Icarus messages
    // Group 1: Filename
    // Group 2: Line number
    // Group 3: Severity (optional)
    // Group 4: Message
    let regex: RegExp = new RegExp(
        String.raw`(${file.replace(
            /[-[\]{}()*+?.,\\^$|#\s]/g,
            '\\$&')}):(\d+):(?: (error|warning):)? (.*)`,
        'i');

    // Parse output lines
    for (let i = 0; i < lines.length; ++i) {
        const line = lines[i];
        let terms = line.match(regex);
        if (terms != null) {
            let message = terms[4];
            let severity = getIcarusSeverity(terms[3], message);
            let lineNum = parseInt(terms[2]) - 1;

            let messageWhiteListed: Boolean = false;
            for (let whitelistedMessage of whitelistedMessages) {
                if (message.search(whitelistedMessage) >= 0) {
                    messageWhiteListed = true;
                    break;
                }
            }
            if (messageWhiteListed) {
                continue;
            }

            if (lineNum != NaN) {
                diagnostics.push({
                    severity: severity,
                    range: Range.create(lineNum, 0, lineNum, 0),
                    message: message,
                    code: 'iverilog',
                    source: 'iverilog'
                });
            }
        }
    }

    return diagnostics;
}

export class VerilogDiagnostics {
    private _indexer: SystemVerilogIndexer;
    private _linter: 'icarus' | 'verilator' = 'icarus';
    private _command: string = '';
    private _defines: string[] = [];
    private _optionsFile: string = '';
    private _childProcMngr: ChildProcManager = new ChildProcManager();
    private _delayedCaller: DelayedCaller = new DelayedCaller();
    private _whitelistedMessages: RegExp[] = [];

    constructor(indexer: SystemVerilogIndexer) {
        this._indexer = indexer;
    }

    public setCommand(cmd: string) {
        this._command = cmd;
    }

    public setLinter(linter: 'icarus' | 'verilator') {
        this._linter = linter;
    }

    public setOptionsFile(file: string) {
        this._optionsFile = file;
    }

    public setWhitelistedMessages(msgs: string[]) {
        this._whitelistedMessages = msgs.map(m => new RegExp(m));
    }

    public setDefines(defines: string[]) {
        this._defines = defines || [];
    }

    private _lintImmediate(file: string, text?: string): Promise<Diagnostic[]> {
        this._childProcMngr.kill(file);
        return new Promise((resolve, reject) => {
            let fileWithoutRoot: string = file.slice(path.parse(file).root.length);
            let actFile: string = text == undefined ?
                file :
                tmpFileManager.getTmpFilePath('sources', fileWithoutRoot);
            let optionsFile: string = this._optionsFile;
            let vcTmpFileNum: number;
            if (text != undefined) {
                fsWriteFileSync(actFile, text);

                // if file write takes too long and another process started in the
                // interim
                this._childProcMngr.kill(file);

                if (this._indexer.fileHasPkg(file)) {
                    let vcFileContent: string =
                        this._indexer.getOptionsFileContent()
                            .map(line => {
                                return (line.endsWith(file)) ?
                                    line.slice(0, line.length - file.length) + actFile :
                                    line;
                            })
                            .join('\n');
                    vcTmpFileNum = tmpFileManager.getFreeTmpFileNum('vcfiles');
                    let tmpVcFile: string = tmpFileManager.getTmpFilePath(
                        'vcfiles', `lint${vcTmpFileNum}.vc`);
                    fsWriteFileSync(tmpVcFile, vcFileContent);
                    optionsFile = tmpVcFile;

                    // if file write takes too long and another process started in the
                    // interim
                    this._childProcMngr.kill(file);
                }
            }

            let definesArg: string = this._defines.length > 0 ?
                this._defines.map(d => ` +define+${d}`).join('') :
                '';
            optionsFile = fs.existsSync(optionsFile) ? optionsFile :
                '';  // check option file exist
            let optionsFileArg: string = optionsFile ? ' -f ' + optionsFile : '';
            let actFileArg: string =
                this._indexer.isMustSrcFile(file) ? '' : ' ' + actFile;
            // let command: string = this._command + definesArg + optionsFileArg +
            // actFileArg;

            let useWSL = settings.get('systemverilog.lintingVerilatorUseWSL');
            if (useWSL) {
                actFile = actFile.replace(/\\/g, '/');
                actFileArg = ` \$(wslpath '${actFile}')`;
                optionsFileArg = optionsFile != '' ?
                    ` -f \$(wslpath '${optionsFile.replace(/\\/g, '/')}')` :
                    '';
                optionsFileArg += ` -y \$(wslpath '${path.dirname(actFile)}')`
            }

            // auto construct 2 level dir for verilator
            getFileList(
                path.dirname(actFile),
                {
                    levelMax:
                        settings.get('systemverilog.lintingVerilatorAutoScanDirLevel'),
                    fileType: 'd',
                    filePattern: /^[^.].*/
                },
                f => {
                    // filter each file
                    if (path.basename(f).startsWith('.')) return null;
                    return useWSL ? ` -y \$(wslpath '${f}')` : ` -y '${f}'`;
                },
                files => {
                    // process all files
                    let command: string = this._command + definesArg + optionsFileArg +
                        files.join('') + actFileArg;
                    if (useWSL && !command.startsWith('wsl '))
                        command = 'wsl ' + command;

                    ConnectionLogger.log(`DEBUG: verilator command: ${command}`);
                    this._childProcMngr.run(
                        file, command, (status, error, stdout, stderr) => {
                            if (optionsFile != this._optionsFile) {
                                tmpFileManager.returnFreeTmpFileNum(
                                    'vcfiles', vcTmpFileNum);
                            }
                            if (status) {
                                switch (this._linter) {
                                    case 'icarus':
                                        resolve(parseIcarusDiagnostics(
                                            stdout, stderr, actFile,
                                            this._whitelistedMessages));
                                        break;
                                    case 'verilator':
                                        let diagnostics: Diagnostic[] = parseVerilatorDiagnostics(
                                            stdout, stderr, actFile, this._whitelistedMessages);
                                        if (useWSL) {
                                            diagnostics.forEach(d => {
                                                d.source = d.source.replace(/\/mnt\/([a-zA-Z]+)/, "\$1:").replace(/\//g, '\\');
                                            });
                                        }
                                        resolve(diagnostics);
                                        break;
                                    default:
                                        reject(new Error(`Unknown linter ${this._linter}`));
                                        break;
                                }
                            } else {
                                resolve([]);
                            }
                        });
                });
        });
    }

    public lint(file: string, text?: string): Promise<Diagnostic[]> {
        try {
            if (text == undefined) {
                return this._lintImmediate(file, text).catch(error => {
                    ConnectionLogger.error(error);
                    return [];
                });
            } else {
                return this._delayedCaller.run(
                    file,
                    (success) => {
                        if (!!success) {
                            return this._lintImmediate(file, text);
                        }
                        return [];
                    },
                    (error) => {
                        ConnectionLogger.error(error);
                        return [];
                    });
            }
        } catch (error) {
            ConnectionLogger.error(error);
            return Promise.resolve([]);
        }
    }

    public cleanupTmpFiles() {
        tmpFileManager.cleanupTmpFiles();
    }
}
