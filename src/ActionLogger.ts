/**
 * VS Code 操作日志记录扩展
 * 用于跟踪和记录 VS Code 内各种用户操作和事件
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http'; 

/**
 * 日志条目接口定义
 * 定义了每条日志的基本结构
 */
interface LogEntry {
    timestamp: string;    // 时间戳
    action: string;       // 操作类型
    details: object;      // 详细信息
    topic: string;        // 主题分类
    userId: string;       // 用户标识
}

/**
 * ActionLogger 类
 * 实现 VS Code 的可释放接口，用于管理资源清理
 */
export default class ActionLogger implements vscode.Disposable {
    private topic: string;                    // 日志主题
    private backendUrl: string;               // 后端服务URL
    private userId: string;                   // 用户ID
    private disposables: vscode.Disposable[] = []; // 可释放资源数组
    private queueFlushInterval = 60000;       // 队列刷新间隔（毫秒）
    private flushTimer: any;                  // 定时器引用
    private cacheFilePath: string;            // 缓存文件路径

    /**
     * 构造函数
     * @param context VS Code 扩展上下文
     * @param topic 日志主题
     * @param backendUrl 后端服务URL
     * @param actions 需要监听的动作列表
     * @param userId 用户ID
     */
    constructor(context: vscode.ExtensionContext, topic: string, backendUrl: string, actions: string[], userId: string) {
        this.topic = topic;
        this.userId = userId;
        this.backendUrl = backendUrl;
        this.cacheFilePath = path.join(context.globalStorageUri.fsPath, '.actionLoggerCache.json');
        console.log(this.cacheFilePath);
        this.ensureCacheFileExists();
        this.subscribeToActions(actions);
        this.startFlushTimer();
    }

    /**
     * 更新用户ID
     * @param newUserId 新的用户ID
     */
    updateUserId(newUserId: string) {
        this.userId = newUserId;
    }

    // 工作区文件夹引用
    workspaceFolders = vscode.workspace.workspaceFolders;
   
    /**
     * 检查文件路径是否在指定文件夹内
     * @param filePath 待检查的文件路径
     * @returns 布尔值，表示是否在目标文件夹内
     */
    private isWithinCsc111Folder(filePath: string): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return false;
        }
        const csc111FolderPath = path.join(workspaceFolders[0].uri.fsPath, 'csc111');
        return filePath.startsWith(csc111FolderPath);
    }

    /**
     * 确保缓存文件存在
     * 如果缓存文件或目录不存在，则创建它们
     */
    private ensureCacheFileExists(): void {
        const dir = path.dirname(this.cacheFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.cacheFilePath)) {
            fs.writeFileSync(this.cacheFilePath, JSON.stringify([]), 'utf8');
        }
    }

    /**
     * 启动定时刷新器
     * 定期将缓存的日志发送到服务器
     */
    private startFlushTimer(): void {
        this.flushTimer = setInterval(() => {
            this.flushMessageQueue();
        }, this.queueFlushInterval);
    }

    /**
     * 刷新消息队列
     * 读取缓存文件并尝试将日志发送到服务器
     */
    private flushMessageQueue(): void {
        const logsToFlush = this.readCacheFile();
        if (logsToFlush.length === 0){
            return;
        }
        const postData = JSON.stringify(logsToFlush);
    
        const options = {
            hostname: new URL(this.backendUrl).hostname,
            port: new URL(this.backendUrl).port || 8080,
            path: new URL(this.backendUrl).pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };
    
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 202) {
                    console.log('Logs successfully sent to the server');
                    fs.writeFileSync(this.cacheFilePath, JSON.stringify([]), 'utf8');
                } else {
                    console.error(`Failed to send logs, server responded with status code: ${res.statusCode}`);
                }
            });
        });
    
        req.on('error', (e) => {
            console.error(`Problem with request: ${e.message}`);
        });
    
        req.write(postData);
        req.end();
    }
    
    /**
     * 订阅动作事件
     * 为不同类型的操作注册相应的事件处理器
     * @param actions 需要监听的动作列表
     */
    private subscribeToActions(actions: string[]): void {
        actions.forEach(action => {
            switch (action) {
                case 'openDocument':
                    this.disposables.push(vscode.workspace.onDidOpenTextDocument(this.handleOpenDocument.bind(this)));
                    break;
                case 'startDebugSession':
                    this.disposables.push(vscode.debug.onDidStartDebugSession(this.handleStartDebugSession.bind(this)));
                    break;
                case 'endDebugSession':
                    this.disposables.push(vscode.debug.onDidTerminateDebugSession(this.handleTerminateDebugSession.bind(this)));
                    break;
                case 'endTaskProcess':
                    this.disposables.push(vscode.tasks.onDidEndTaskProcess(this.handleEndTaskProcess.bind(this)));
                    break;
                case 'saveDocument':
                    this.disposables.push(vscode.workspace.onDidSaveTextDocument(this.handleSaveDocument.bind(this)));
                    break;
                case 'terminalOpened':
                    this.disposables.push(vscode.window.onDidOpenTerminal(this.handleOpenTerminal.bind(this)));
                    break;
                case 'terminalClosed':
                    this.disposables.push(vscode.window.onDidCloseTerminal(this.handleCloseTerminal.bind(this)));
                    break;
                case 'terminalActiveChanged':
                    this.disposables.push(vscode.window.onDidChangeActiveTerminal(this.handleChangeActiveTerminal.bind(this)));
                    break;
                case 'diagnosticsChanged':
                    this.disposables.push(vscode.languages.onDidChangeDiagnostics(this.handleDiagnosticsChange.bind(this)));
                    break;
                case 'textDocumentChanged':
                    this.disposables.push(vscode.workspace.onDidChangeTextDocument(this.handleTextDocumentChange.bind(this)));
                    break;
            }
        });
    }

    /**
     * 处理终端打开事件
     * @param terminal 终端实例
     */
    private handleOpenTerminal(terminal: vscode.Terminal): void {
        this.logAction('terminalOpened', { terminalName: terminal.name });
    }

    /**
     * 处理终端关闭事件
     * @param terminal 终端实例
     */
    private handleCloseTerminal(terminal: vscode.Terminal): void {
        this.logAction('terminalClosed', { terminalName: terminal.name });
    }

    /**
     * 处理活动终端改变事件
     * @param terminal 当前活动的终端实例
     */
    private handleChangeActiveTerminal(terminal: vscode.Terminal | undefined): void {
        if (terminal) {
            this.logAction('terminalActiveChanged', { terminalName: terminal.name, status: 'activated' });
        } else {
            this.logAction('terminalActiveChanged', { status: 'deactivated' });
        }
    }
 
    /**
     * 处理诊断信息变化事件
     * @param event 诊断变化事件
     */
    private handleDiagnosticsChange(event: vscode.DiagnosticChangeEvent): void {
        event.uris.forEach(uri => {
            if (this.isWithinCsc111Folder(uri.fsPath)) {
                const diagnostics = vscode.languages.getDiagnostics(uri);
                const errors = diagnostics.filter(diag => diag.severity === vscode.DiagnosticSeverity.Error);
                const warnings = diagnostics.filter(diag => diag.severity === vscode.DiagnosticSeverity.Warning);
                
                this.logAction('diagnosticsChanged', {
                    fileName: path.basename(uri.fsPath),
                    errorCount: errors.length,
                    warningCount: warnings.length,
                    errorMessages: errors.map(e => e.message),
                    warningMessages: warnings.map(w => w.message)
                });
            }
        });
    }

    /**
     * 处理文档内容变化事件
     * @param event 文档变化事件
     */
    private handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        if (this.isWithinCsc111Folder(event.document.uri.fsPath)) {
            const changes = event.contentChanges.map(change => ({
                range: {
                    start: { line: change.range.start.line, character: change.range.start.character },
                    end: { line: change.range.end.line, character: change.range.end.character }
                },
                text: change.text
            }));

            this.logAction('textDocumentChanged', {
                fileName: path.basename(event.document.fileName),
                changeCount: event.contentChanges.length,
                changes: changes
            });
        }
    }

    /**
     * 处理文档打开事件
     * @param document 文档实例
     */
    private handleOpenDocument(document: vscode.TextDocument): void {
        if (this.isWithinCsc111Folder(document.uri.fsPath)) {
            this.logAction('openDocument', { fileName: document.fileName });
        }
    }

    /**
     * 处理调试会话开始事件
     * @param session 调试会话实例
     */
    private handleStartDebugSession(session: vscode.DebugSession): void {
        if (session.workspaceFolder && this.isWithinCsc111Folder(session.workspaceFolder.uri.fsPath)) {
            this.logAction('startDebugSession', { sessionName: session.name });
        }
    }

    /**
     * 处理调试会话结束事件
     * @param session 调试会话实例
     */
    private handleTerminateDebugSession(session: vscode.DebugSession): void {
        if (session.workspaceFolder && this.isWithinCsc111Folder(session.workspaceFolder.uri.fsPath)) {
            this.logAction('endDebugSession', { sessionName: session.name });
        }
    }

    /**
     * 处理任务进程结束事件
     * @param event 任务进程结束事件
     */
    private handleEndTaskProcess(event: vscode.TaskProcessEndEvent): void {
        this.logAction('endTaskProcess', { taskName: event.execution.task.name, exitCode: event.exitCode });
    }

    /**
     * 处理文档保存事件
     * @param document 文档实例
     */
    private handleSaveDocument(document: vscode.TextDocument): void {
        if (this.isWithinCsc111Folder(document.uri.fsPath)) {
            const documentContent = document.getText();
            this.logAction('saveDocument', { fileName: document.fileName, contentPreview: documentContent });
        }
    }
    
    /**
     * 记录操作日志
     * @param action 操作类型
     * @param details 详细信息
     */
    public logAction(action: string, details: object): void {
        const logEntry: LogEntry = {
            timestamp: Date.now().toString(),
            action,
            details,
            userId: this.userId,
            topic: this.topic,
        };
        const currentLogs = this.readCacheFile();
        currentLogs.push(logEntry);
        fs.writeFileSync(this.cacheFilePath, JSON.stringify(currentLogs), 'utf8');
    }
  
    /**
     * 读取缓存文件
     * @returns 缓存的日志条目数组
     */
    private readCacheFile(): LogEntry[] {
        try {
            const data = fs.readFileSync(this.cacheFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading cache file:', error);
            return [];
        }
    }

    /**
     * 释放资源
     * 清理定时器并确保所有日志都被发送
     */
    dispose(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer as NodeJS.Timeout);
        }
        this.flushMessageQueue(); // Ensure the queue is flushed on dispose
    }
}