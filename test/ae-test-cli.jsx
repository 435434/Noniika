/**
 * ae-test-cli.jsx —— 命令行（静默）运行 ae-test.jsx 的包装器
 * ==========================================================
 * 用法：
 *   "<AE 安装目录>\Support Files\AfterFX.exe" ^
 *       -r "<项目路径>\test\ae-test-cli.jsx"
 *
 * 与直接双击运行 ae-test.jsx 的区别：不弹模态对话框，结果只写文件 + 控制台，
 * 适合自动化/远程调试。
 */

var AESUB_TEST_SILENT = true;

var self = new File($.fileName);
$.evalFile(new File(self.parent.fsName + "/ae-test.jsx"));
