/**
 * CSC111 课程辅助 VS Code 扩展
 * 
 * 主要功能：
 * 1. 课程模板文件下载和管理
 * 2. Python包管理和安装
 * 3. 主题推荐
 * 4. 用户行为日志记录
 * 
 * 架构组成：
 * - HttpClient: HTTP请求处理
 * - TemplateManager: 模板文件管理
 * - PackageManager: Python包管理
 * - UserManager: 用户管理
 * - ExtensionState: 扩展状态管理
 * - ExtensionController: 扩展控制器
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { exec } from 'child_process';
import ActionLogger from './ActionLogger';

// 全局配置定义
const CONFIG = {
    SERVER: {
        HOST: '127.0.0.1', // TODO: 配置服务器地址
        PORT: 8080,
        RETRY_ATTEMPTS: 3,    // 请求失败重试次数
        RETRY_DELAY: 1000,    // 重试间隔时间(ms)
        TIMEOUT: 5000,        // 请求超时时间(ms)
    },
    PATHS: {
        VALIDATE_USER: '/validate_user',
        LOG: '/log',
        TEMPLATE: '/template'
    },
    FILES: {
        USERNAME_CACHE: '.usernameCache.json'
    },
    EXTENSION: {
        THEME_ID: 'Troulette.troulette',
        THEME_AVAILABLE_DATE: '2024-10-09' //修改可下载日期
    }
};

/**
 * 接口定义
 */
interface RequestOptions extends http.RequestOptions {
    timeout?: number;
}

interface HttpResponse {
    statusCode: number;
    data: string | Buffer;
    headers?: http.IncomingHttpHeaders;
}

interface FileStructure {
    [key: string]: string[];
}

/**
 * HTTP客户端实现
 * 特点：
 * 1. 单例模式
 * 2. 自动重试机制
 * 3. 超时处理
 * 4. 错误恢复
 */
class HttpClient {
    private static instance: HttpClient;
    private requestQueue: Array<() => Promise<any>> = [];
    private isProcessingQueue = false;

    private constructor() {}

    static getInstance(): HttpClient {
        if (!this.instance) {
            this.instance = new HttpClient();
        }
        return this.instance;
    }

    /**
     * 发送HTTP请求
     * @param options 请求配置选项
     * @param postData POST数据
     * @param retryCount 当前重试次数
     */
    async request(options: RequestOptions, postData?: string, retryCount = 0): Promise<HttpResponse> {
        return new Promise((resolve, reject) => {
            const req = http.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const data = Buffer.concat(chunks);
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({
                            statusCode: res.statusCode,
                            data: data,
                            headers: res.headers
                        });
                    } else {
                        reject(new Error(`HTTP Error: ${res.statusCode}`));
                    }
                });
            });

            // 设置超时
            req.setTimeout(options.timeout || CONFIG.SERVER.TIMEOUT, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            // 错误处理和重试逻辑
            req.on('error', async (error) => {
                if (retryCount < CONFIG.SERVER.RETRY_ATTEMPTS) {
                    await this.delay(CONFIG.SERVER.RETRY_DELAY * Math.pow(2, retryCount));
                    try {
                        const result = await this.request(options, postData, retryCount + 1);
                        resolve(result);
                    } catch (retryError) {
                        reject(retryError);
                    }
                } else {
                    // 将失败的请求加入队列以便后续重试
                    this.queueRequest(() => this.request(options, postData, 0));
                    reject(error);
                }
            });

            if (postData) {
                req.write(postData);
            }
            req.end();
        });
    }

    /**
     * 将请求加入重试队列
     * @param request 请求函数
     */
    private queueRequest(request: () => Promise<any>): void {
        this.requestQueue.push(request);
        if (!this.isProcessingQueue) {
            this.processQueue();
        }
    }

    /**
     * 处理请求队列
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;
        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift();
            if (request) {
                try {
                    await request();
                } catch (error) {
                    console.error('Error processing queued request:', error);
                }
                await this.delay(100);
            }
        }
        this.isProcessingQueue = false;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * 用户管理器
 * 负责用户验证和信息缓存
 */
class UserManager {
    private context: vscode.ExtensionContext;
    private httpClient: HttpClient;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.httpClient = HttpClient.getInstance();
    }

    /**
     * 获取缓存的用户名
     */
    async getCachedUsername(): Promise<string | undefined> {
        const cacheFile = this.getUsernameCacheFilePath();
        
        if (!fs.existsSync(path.dirname(cacheFile))) {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        }

        try {
            if (fs.existsSync(cacheFile)) {
                const data = fs.readFileSync(cacheFile, 'utf8');
                const cache = JSON.parse(data);
                return cache.username;
            }
        } catch (error) {
            console.error('Error reading username cache:', error);
        }
        return undefined;
    }

    /**
     * 验证并缓存用户名
     * @param userId 用户ID
     */
    async validateAndCacheUsername(userId: string): Promise<void> {
        const postData = JSON.stringify({ username: userId });
        const options: RequestOptions = {
            hostname: CONFIG.SERVER.HOST,
            port: CONFIG.SERVER.PORT,
            path: CONFIG.PATHS.VALIDATE_USER,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        try {
            const response = await this.httpClient.request(options, postData);
            if (response.statusCode === 200) {
                await this.cacheUsername(userId);
            } else {
                throw new Error('User validation failed');
            }
        } catch (error) {
            throw new Error(`Failed to validate user: ${error}`);
        }
    }

    /**
     * 缓存用户名
     * @param username 用户名
     */
    private async cacheUsername(username: string): Promise<void> {
        try {
            const cacheFile = this.getUsernameCacheFilePath();
            const tempFile = `${cacheFile}.tmp`;
            
            // 使用临时文件进行原子写入
            await fs.promises.writeFile(
                tempFile,
                JSON.stringify({ username, timestamp: new Date().toISOString() }),
                'utf8'
            );
            await fs.promises.rename(tempFile, cacheFile);
        } catch (error) {
            throw new Error(`Failed to cache username: ${error}`);
        }
    }

    private getUsernameCacheFilePath(): string {
        return path.join(this.context.globalStoragePath, CONFIG.FILES.USERNAME_CACHE);
    }
}

/**
 * 模板管理器
 * 负责模板文件的下载和管理
 */
class TemplateManager {
    private context: vscode.ExtensionContext;
    private httpClient: HttpClient;
    private logger: ActionLogger;
    private statusBarItem: vscode.StatusBarItem;

    constructor(context: vscode.ExtensionContext, logger: ActionLogger) {
        this.context = context;
        this.httpClient = HttpClient.getInstance();
        this.logger = logger;
        this.statusBarItem = this.createStatusBarItem();
    }

    /**
     * 创建状态栏项
     */
    private createStatusBarItem(): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 601);
        item.text = '$(play) Download Templates';
        item.tooltip = 'Download Templates';
        item.command = 'extension.downloadPythonTemplates';
        item.show();
        return item;
    }

    /**
     * 获取文件结构定义
     */
    private getFileStructure(): FileStructure {
        return {
            'templates':['CSC111_design_file_template.docx','CSC111_test_plan_template.docx','CSC111_Python_source_file_template.py'],
			'week1': ['helloworld.py', 'helloworld_notebook.ipynb','matplotlib_numpy_scipy_pandas_test.ipynb'],
			'week2': ['homework2.py', 'inlab2.py'],
			'week3': ['homework3.py', 'inlab3.py'],
			'week4': ['homework4.py', 'inlab4.py'],
			'week5': ['homework5.py', 'inlab5.py'],
			'week6': ['homework6.py', 'inlab6.py'],
			'week7': ['homework7.py', 'inlab7.py'],
			'week8': ['homework8.py', 'inlab8.py'],
			'week9': ['homework9.py', 'inlab9.py'],
			'week10': ['homework10.py', 'inlab10.py'],
			'week11': ['homework11.py', 'inlab11.py'],
			'week12': ['homework12.py', 'inlab12.py'],
			'week13': ['homework13.py', 'inlab13.py'],
			'project1':[],
			'project2':[],
			'project3':[]
        };
    }

    /**
     * 从服务器获取模板文件
     */
    private async fetchTemplateFromServer(fileName: string): Promise<Buffer> {
        const options: RequestOptions = {
            hostname: CONFIG.SERVER.HOST,
            port: CONFIG.SERVER.PORT,
            path: `${CONFIG.PATHS.TEMPLATE}/${fileName}`,
            method: 'GET'
        };

        try {
            const response = await this.httpClient.request(options);
            if (response.statusCode === 200) {
                return response.data as Buffer;
            }
            throw new Error(`Failed to fetch template: ${response.statusCode}`);
        } catch (error) {
            throw new Error(`Template fetch error: ${error}`);
        }
    }

    /**
     * 下载并创建模板文件
     */
    async downloadTemplates(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error("Please open a workspace to download the templates.");
        }

        const targetFolder = path.join(workspaceFolders[0].uri.fsPath, 'csc111');
        const fileStructure = this.getFileStructure();
        let createdFiles = 0;

        try {
            // 确保目标文件夹存在
            if (!fs.existsSync(targetFolder)) {
                fs.mkdirSync(targetFolder);
            }

            // 创建文件结构
            for (const [weekFolder, files] of Object.entries(fileStructure)) {
                const weekPath = path.join(targetFolder, weekFolder);
                
                if (!fs.existsSync(weekPath)) {
                    fs.mkdirSync(weekPath);
                }

                // 下载每个文件
                for (const fileName of files) {
                    const targetFilePath = path.join(weekPath, fileName);
                    if (!fs.existsSync(targetFilePath)) {
                        try {
                            const fileContent = await this.fetchTemplateFromServer(fileName);
                            await this.writeFile(targetFilePath, fileContent, fileName);
                            createdFiles++;
                        } catch (error) {
                            console.error(`Error downloading ${fileName}:`, error);
                            vscode.window.showErrorMessage(`Failed to download ${fileName}`);
                        }
                    }
                }
            }

            // 记录日志并显示结果
            await this.logger.logAction('user_create_template', { create_number: createdFiles });
            if (createdFiles > 0) {
                vscode.window.showInformationMessage(
                    `${createdFiles} CSC111 files have been created successfully!`
                );
            } else {
                vscode.window.showInformationMessage('No new files needed to be created.');
            }

        } catch (error) {
            throw new Error(`Failed to download templates: ${error}`);
        }
    }

    /**
     * 写入文件
     * @param filePath 文件路径
     * @param content 文件内容
     * @param fileName 文件名
     */
    private async writeFile(filePath: string, content: Buffer, fileName: string): Promise<void> {
        const tempFile = `${filePath}.tmp`;
        try {
            if (fileName.endsWith('.ipynb')) {
                const jsonContent = JSON.parse(content.toString());
                await fs.promises.writeFile(tempFile, JSON.stringify(jsonContent, null, 2));
            } else {
                await fs.promises.writeFile(tempFile, content);
            }
            await fs.promises.rename(tempFile, filePath);
        } catch (error) {
            if (fs.existsSync(tempFile)) {
                await fs.promises.unlink(tempFile);
            }
            throw error;
        }
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}

/**
 * Python包管理器
 * 负责Python环境检测和包安装
 */
class PackageManager {
    private context: vscode.ExtensionContext;
    private logger: ActionLogger;
    private statusBarItem: vscode.StatusBarItem;
    private requiredPackages = ['matplotlib', 'numpy', 'scipy', 'pandas'];

    constructor(context: vscode.ExtensionContext, logger: ActionLogger) {
        this.context = context;
        this.logger = logger;
        this.statusBarItem = this.createStatusBarItem();
    }

    /**
     * 创建状态栏项
     */
    private createStatusBarItem(): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 600);
        item.text = '$(package) Install Python Packages';
        item.tooltip = 'Install required Python packages';
        item.command = 'extension.installPythonPackages';
        item.show();
        return item;
    }

    /**
     * 检查并安装Python包
     */
    async installPackages(): Promise<void> {
        try {
            const pythonExtension = vscode.extensions.getExtension('ms-python.python');
            if (!pythonExtension) {
                throw new Error('Please install and enable the Python extension for VSCode first.');
            }

            if (!pythonExtension.isActive) {
                await pythonExtension.activate();
            }

            const pythonApi = pythonExtension.exports;
            const activeInterpreter = await pythonApi.environments.getActiveEnvironmentPath();

            if (!activeInterpreter?.path) {
                throw new Error('No active Python interpreter found. Please select a Python interpreter in VSCode.');
            }

            await this.validateAndInstallPackages(activeInterpreter.path);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Package installation failed: ${errorMessage}`);
        }
    }

    /**
     * 验证Python环境并安装包
     * @param pythonPath Python解释器路径
     */
    private async validateAndInstallPackages(pythonPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            exec(`${pythonPath} --version`, async (error) => {
                if (error) {
                    reject(new Error('Selected Python interpreter is not valid.'));
                    return;
                }

                try {
                    const terminal = vscode.window.createTerminal('Package Installer');
                    terminal.show();

                    vscode.window.showInformationMessage(
                        `Installing packages: ${this.requiredPackages.join(', ')}. This may take a few minutes.`
                    );

                    // 安装包
                    for (const pkg of this.requiredPackages) {
                        terminal.sendText(`${pythonPath} -m pip install ${pkg}`);
                    }

                    // 验证安装
                    terminal.sendText(
                        `${pythonPath} -c "import ${this.requiredPackages.join(', ')}; print('Packages installed successfully!')" || echo "Failed to import packages."`
                    );

                    // 记录日志
                    await this.logger.logAction('install_python_packages', {
                        packages: this.requiredPackages.join(', '),
                        pythonPath
                    });

                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}

/**
 * 主题推荐管理器
 * 负责主题安装和推荐
 */
class ThemeManager {
    private context: vscode.ExtensionContext;
    private logger: ActionLogger;
    private statusBarItem: vscode.StatusBarItem;

    constructor(context: vscode.ExtensionContext, logger: ActionLogger) {
        this.context = context;
        this.logger = logger;
        this.statusBarItem = this.createStatusBarItem();
    }

    /**
     * 创建状态栏项
     */
    private createStatusBarItem(): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        item.text = '$(cloud-download) MyTheme';
        item.tooltip = 'Theme Recommendations';
        item.command = 'extension.troulette';
        item.show();
        return item;
    }

    /**
     * 获取当前主题
     */
    private getCurrentTheme(): string {
        return vscode.workspace.getConfiguration('workbench').get('colorTheme') || 'Unknown';
    }

    /**
     * 处理主题推荐
     */
    async handleThemeRecommendation(): Promise<void> {
        try {
            const currentDate = new Date();
            const targetDate = new Date(CONFIG.EXTENSION.THEME_AVAILABLE_DATE);

            if (currentDate < targetDate) {
                const currentTheme = this.getCurrentTheme();
                vscode.window.showInformationMessage(`Current VSCode theme: ${currentTheme}`);
                return;
            }

            const extension = vscode.extensions.getExtension(CONFIG.EXTENSION.THEME_ID);
            if (!extension) {
                await vscode.commands.executeCommand(
                    'workbench.extensions.installExtension',
                    CONFIG.EXTENSION.THEME_ID
                );
                vscode.window.showInformationMessage('Theme extension has been installed.');
                await this.logger.logAction('theme_extension_installed', {
                    extensionId: CONFIG.EXTENSION.THEME_ID
                });
            } else {
                const currentTheme = this.getCurrentTheme();
                vscode.window.showInformationMessage(`Current VSCode theme: ${currentTheme}`);
                await this.logger.logAction('theme_info_displayed', { currentTheme });
            }
        } catch (error) {
            throw new Error(`Theme recommendation failed: ${error}`);
        }
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}

/**
 * 扩展状态管理器
 * 负责管理扩展的整体状态和生命周期
 */
class ExtensionState {
    private static instance: ExtensionState;
    private _isActivating = false;
    private _isDeactivating = false;
    private _activationPromise: Promise<void> | null = null;
    private activationResolve: (() => void) | null = null;

    private constructor() {}

    static getInstance(): ExtensionState {
        if (!ExtensionState.instance) {
            ExtensionState.instance = new ExtensionState();
        }
        return ExtensionState.instance;
    }

    get isActivating(): boolean {
        return this._isActivating;
    }

    get isDeactivating(): boolean {
        return this._isDeactivating;
    }

    beginActivation(): void {
        if (this._isActivating) {
            return;
        }
        this._isActivating = true;
        this._activationPromise = new Promise((resolve) => {
            this.activationResolve = resolve;
        });
    }

    completeActivation(): void {
        this._isActivating = false;
        if (this.activationResolve) {
            this.activationResolve();
            this.activationResolve = null;
            this._activationPromise = null;
        }
    }

    beginDeactivation(): void {
        this._isDeactivating = true;
    }

    completeDeactivation(): void {
        this._isDeactivating = false;
    }

    async waitForActivation(): Promise<void> {
        return this._activationPromise || Promise.resolve();
    }
}

/**
 * 扩展控制器
 * 负责协调各个组件的初始化和生命周期管理
 */
class ExtensionController {
    private context: vscode.ExtensionContext;
    private state: ExtensionState;
    private userManager: UserManager;
    // 使用 ! 断言这些属性会在初始化时被赋值
    private templateManager!: TemplateManager;
    private packageManager!: PackageManager;
    private themeManager!: ThemeManager;
    private logger!: ActionLogger;
    private disposables: vscode.Disposable[] = [];

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.state = ExtensionState.getInstance();
        this.userManager = new UserManager(context);
    }

    /**
     * 初始化扩展
     */
    async initialize(): Promise<void> {
        try {
            this.state.beginActivation();

            // 初始化用户
            const userId = await this.initializeUser();

            // 初始化日志记录器
            this.logger = new ActionLogger(
                this.context,
                "base",
                `http://${CONFIG.SERVER.HOST}:${CONFIG.SERVER.PORT}${CONFIG.PATHS.LOG}`,
                ['openDocument', 'startDebugSession', 'endDebugSession', 'endTaskProcess', 'saveDocument'],
                userId
            );

            // 初始化其他管理器
            this.templateManager = new TemplateManager(this.context, this.logger);
            this.packageManager = new PackageManager(this.context, this.logger);
            this.themeManager = new ThemeManager(this.context, this.logger);

            // 注册命令
            this.registerCommands();

            this.state.completeActivation();
        } catch (error) {
            this.state.completeActivation();
            throw this.handleError(error);
        }
    }

    /**
     * 错误处理
     */
    private handleError(error: unknown): Error {
        const errorMessage = error instanceof Error 
            ? error.message 
            : String(error);
        
        console.error('Extension error:', errorMessage);
        return new Error(`Extension initialization failed: ${errorMessage}`);
    }

    /**
     * 初始化用户
     */
    private async initializeUser(): Promise<string> {
        let userId = await this.userManager.getCachedUsername();
        let attempts = 0;

        while (!userId && attempts < 3) {
            userId = await vscode.window.showInputBox({
                prompt: "Please enter your User ID",
                placeHolder: "User ID",
                ignoreFocusOut: true
            });

            if (userId) {
                try {
                    await this.userManager.validateAndCacheUsername(userId);
                    break;
                } catch (error) {
                    const errorMessage = error instanceof Error 
                        ? error.message 
                        : String(error);
                    console.error('User validation error:', errorMessage);
                    vscode.window.showWarningMessage("Failed to validate User ID. Please try again.");
                    userId = undefined;
                }
            } else {
                throw new Error("User ID is required for extension activation.");
            }

            attempts++;
        }

        if (!userId) {
            throw new Error("Invalid User ID after 3 attempts. Please contact the administrator.");
        }

        return userId;
    }

    /**
     * 注册命令
     */
    private registerCommands(): void {
        this.disposables.push(
            vscode.commands.registerCommand('extension.downloadPythonTemplates', async () => {
                try {
                    await this.templateManager.downloadTemplates();
                } catch (error) {
                    const errorMessage = error instanceof Error 
                        ? error.message 
                        : String(error);
                    vscode.window.showErrorMessage(`Failed to download templates: ${errorMessage}`);
                }
            }),
            vscode.commands.registerCommand('extension.installPythonPackages', async () => {
                try {
                    await this.packageManager.installPackages();
                } catch (error) {
                    const errorMessage = error instanceof Error 
                        ? error.message 
                        : String(error);
                    vscode.window.showErrorMessage(`Failed to install packages: ${errorMessage}`);
                }
            }),
            vscode.commands.registerCommand('extension.troulette', async () => {
                try {
                    await this.themeManager.handleThemeRecommendation();
                } catch (error) {
                    const errorMessage = error instanceof Error 
                        ? error.message 
                        : String(error);
                    vscode.window.showErrorMessage(`Theme recommendation failed: ${errorMessage}`);
                }
            })
        );
    }

    dispose(): void {
        this.state.beginDeactivation();
        this.disposables.forEach(d => d.dispose());
        this.templateManager?.dispose();
        this.packageManager?.dispose();
        this.themeManager?.dispose();
        this.logger?.dispose();
        this.state.completeDeactivation();
    }
}

/**
 * 扩展激活入口点
 * @param context 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const controller = new ExtensionController(context);
    try {
        await controller.initialize();
        console.log('CSC111 extension is now active!');
    } catch (error) {
        const errorMessage = error instanceof Error 
            ? error.message 
            : String(error);
        vscode.window.showErrorMessage(`Failed to activate extension: ${errorMessage}`);
        throw error;
    }
}

/**
 * 扩展停用入口点
 */
export function deactivate(): void {
    // 清理工作将由 disposables 自动处理
}