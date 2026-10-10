/* Authoritative bilingual content. Generated outputs: USER-GUIDE.md and ../guide.html. */
const pair = (en, zh) => ({ en, zh });
const procedures = [];
function p(id, group, en, zh, before, steps, result, notes = [], caution = []) {
  procedures.push({ id, group, title: pair(en, zh), before: pair(...before),
    steps: steps.map(x => pair(...x)), result: pair(...result),
    notes: notes.map(x => pair(...x)), caution: caution.map(x => pair(...x)) });
}
p('guide', 'start', 'Use this guide', '使用本教程', ['Open SciHub in a browser.', '在浏览器中打开 SciHub。'], [
  ['Select "使用教程" (User guide) in the page footer.', '选择页脚的“使用教程”。'],
  ['Use the contents list to select a task.', '在目录中选择任务。'],
  ['Enter a word in the search field to find a task.', '在搜索框中输入关键词查找任务。'],
  ['Select the language view that you need.', '选择需要的语言显示方式。'],
  ['Compare the guide version with the version in the SciHub footer.', '核对教程版本与 SciHub 页脚的版本。']
], ['You can read the guide without an account.', '无需登录即可阅读教程。'], [
  ['Screenshot numbers match the descriptions below each image.', '截图编号对应图片下方的说明。'],
  ['Screenshots use fictional examples; your titles and records can differ.', '截图使用虚构示例；你的名称和记录可能不同。'],
  ['On a phone, swipe an image left or right to read the details.', '手机上可左右滑动图片查看细节。']
]);
p('navigation', 'start', 'Move between pages', '切换页面与返回主页', ['Open SciHub in a browser.', '在浏览器中打开 SciHub。'], [
  ['Select a task to open its page in the current tab.', '选择任务，在当前标签打开对应页面。'],
  ['Use the browser Back button to return to the previous page.', '使用浏览器后退按钮返回上一页。'],
  ['Use the browser Forward button to open the next visited page.', '使用浏览器前进按钮打开下一条已访问页面。'],
  ['Select the SciHub logo in the top bar to return home.', '选择顶部栏左侧的 SciHub 图标返回主页。'],
  ['Use "小工具" or the account menu from the same top bar.', '在同一顶部栏使用“小工具”或账号菜单。']
], ['SciHub keeps the top bar while you move between pages.', '切换页面时，SciHub 保留顶部栏。'], [
  ['The guide opens in the current tab and uses the same top bar.', '教程在当前标签打开，并使用同一顶部栏。'],
  ['Private pages require login; the guide does not.', '私人页面需要登录；教程无需登录。'],
  ['An unsaved plan draft stays in this page session when you navigate away.', '切换页面时，未保存的方案草稿保留在当前页面会话中。'],
  ['Use Back or Forward to return to the draft before you save it.', '保存前，可使用后退或前进返回草稿。'],
  ['Refresh, logout, and closing the tab can discard an unsaved draft.', '刷新、退出登录或关闭标签可能丢失未保存草稿。'],
  ['Navigation waits for record and experiment saves.', '切页会等待科研记录和实验数据保存。'],
  ['Resolve a save error before you leave.', '保存失败时，先处理错误再离开。'],
  ['An unsaved record form stays in this page session when you use Back or Forward.', '使用后退或前进时，未保存的科研记录表单保留在当前页面会话中。']
]);
p('register', 'account', 'Create an account', '注册账号', ['Use an email address that you can access.', '准备一个可以收取邮件的邮箱。'], [
  ['Select "注册" (Register).', '选择“注册”。'],
  ['Enter your email address.', '填写邮箱。'],
  ['Enter a username that no other account uses.', '填写尚未被其他账号使用的用户名。'],
  ['If necessary, enter your telephone number.', '如有需要，填写电话。'],
  ['Enter your password.', '填写密码。'],
  ['Enter the same password in "确认密码" (Confirm password).', '在“确认密码”中再次填写同一密码。'],
  ['Select "注册" (Register).', '选择“注册”。'],
  ['If SciHub requests email confirmation, open the confirmation email.', '如果 SciHub 要求邮箱验证，打开验证邮件。'],
  ['Complete email confirmation before you log in.', '完成邮箱验证后再登录。']
], ['SciHub opens your account or asks you to confirm your email address.', 'SciHub 登录新账号，或提示完成邮箱验证。'], [
  ['If a name or telephone number is in use, enter a different value.', '如果用户名或电话已被占用，换用其他值。'],
  ['If your account exists, use the login procedure.', '如果账号已经存在，使用登录流程。']
]);
p('login', 'account', 'Log in', '登录', ['You must have an account.', '需要已有账号。'], [
  ['Select "登录" (Log in).', '选择“登录”。'],
  ['Enter your email address, username, or registered telephone number.', '填写邮箱、用户名或已登记的电话。'],
  ['Enter your password.', '填写密码。'],
  ['If necessary, select the eye button to check the password.', '如有需要，选择眼睛按钮查看密码。'],
  ['Select "登录" (Log in).', '选择“登录”。']
], ['SciHub shows your home page.', 'SciHub 显示主页。'], [
  ['If you cannot log in with a username, try your email address.', '如果用户名登录失败，尝试邮箱登录。'],
  ['Do not send your password to another person.', '不要向其他人发送密码。']
]);
p('account-info', 'account', 'Read account information', '查看账号信息', ['Log in.', '先登录。'], [
  ['Open the account menu in the upper right corner.', '打开右上角的账号菜单。'],
  ['Select "账号信息" (Account information).', '选择“账号信息”。'],
  ['Read the email address, username, and telephone number.', '查看邮箱、用户名和电话。'],
  ['Select "关闭" (Close).', '选择“关闭”。']
], ['You return to the current page.', '返回当前页面。'], [
  ['This window shows account information; it does not edit the information.', '此窗口用于查看资料，不提供资料编辑。']
]);
p('password', 'account', 'Change your password', '修改密码', ['Log in.', '先登录。'], [
  ['Open the account menu.', '打开账号菜单。'],
  ['Select "修改密码" (Change password).', '选择“修改密码”。'],
  ['Enter the new password.', '输入新密码。'],
  ['Enter the same password in "确认新密码" (Confirm new password).', '在“确认新密码”中再次输入同一密码。'],
  ['Select "保存" (Save).', '选择“保存”。'],
  ['Wait for "密码已更新" (Password updated).', '等待“密码已更新”的提示。']
], ['Your account uses the new password.', '账号改为使用新密码。']);
p('logout', 'account', 'Log out', '退出登录', ['Make sure that SciHub has saved your changes.', '确认 SciHub 已保存修改。'], [
  ['Open the account menu.', '打开账号菜单。'],
  ['Select "退出登录" (Log out).', '选择“退出登录”。'],
  ['Wait for the login page.', '等待登录页出现。']
], ['The current browser session ends.', '当前浏览器的登录会话结束。'], [], [
  ['Do not close the page if a save error is present.', '出现保存错误时，不要关闭页面。']
]);
p('home', 'home', 'Use the home page', '使用主页和快捷入口', ['Log in.', '先登录。'], [
  ['Select "主页" (Home).', '选择“主页”。'],
  ['Read the experiment calendar and task list.', '查看实验日历和待办。'],
  ['In "进行中的实验", select "继续" to open an experiment.', '在“进行中的实验”中选择“继续”打开实验。'],
  ['In "开始新的实验", select a plan card to read the plan.', '在“开始新的实验”中选择方案卡片查看方案。'],
  ['Use "快捷入口" to open plans, records, or a new record.', '使用“快捷入口”打开方案、记录或新建记录。']
], ['SciHub opens the task that you selected.', 'SciHub 打开所选任务。'], [
  ['The top navigation also opens "实验方案" and "科研记录".', '顶部导航也可打开“实验方案”和“科研记录”。'],
  ['If the page cannot load, select "重试" after you check the network connection.', '页面无法加载时，检查网络连接后选择“重试”。']
]);
p('calendar', 'home', 'Read the experiment calendar', '查看实验日历', ['Open the home page.', '打开主页。'], [
  ['Use "上一月" or "下一月" to select a month.', '使用“上一月”或“下一月”选择月份。'],
  ['Select "回到本月" to return to the current month.', '选择“回到本月”返回当前月份。'],
  ['On a computer, move the pointer onto a date.', '在电脑上，将鼠标移到某个日期。'],
  ['On a phone, tap a date to read its details.', '在手机上，点按某个日期查看详情。'],
  ['Read the experiment names and recorded step activity.', '查看实验名称和已记录的步骤活动。'],
  ['Select another area to close the details.', '点按其他区域关闭详情。']
], ['The calendar shows the activity for the selected date.', '日历显示所选日期的活动。'], [
  ['Calendar activity uses saved experiment records; it is not an instrument log.', '日历活动来自已保存的实验记录，不是仪器日志。']
]);
p('todo-add', 'home', 'Add a task', '添加手动待办', ['Open the home page.', '打开主页。'], [
  ['Select "＋ 添加待办" (Add task).', '选择“＋ 添加待办”。'],
  ['Enter the task in "内容" (Content).', '在“内容”中填写待办。'],
  ['If necessary, enter a deadline.', '如有需要，填写截止时间。'],
  ['Select "添加" (Add).', '选择“添加”。']
], ['The task appears in the task list.', '待办出现在列表中。'], [
  ['An empty deadline makes a task without a time limit.', '截止时间留空时，该待办不设时间限制。']
]);
p('todo-remove', 'home', 'Remove a manual task', '删除手动待办', ['Make sure that you no longer need the task.', '确认不再需要该待办。'], [
  ['Find the manual task on the home page.', '在主页找到手动待办。'],
  ['Select the × button for that task.', '选择该待办的 × 按钮。'],
  ['Make sure that the correct task no longer appears.', '确认正确的待办已从列表消失。']
], ['SciHub removes the manual task.', 'SciHub 删除该手动待办。'], [], [
  ['The × button removes the task immediately; there is no confirmation window.', '× 按钮立即删除待办，不会弹出确认窗口。'],
  ['There is no task restore button.', '目前没有待办恢复按钮。']
]);
p('todo-auto', 'home', 'Use experiment tasks and time reminders', '使用实验待办和计时提醒', ['Start or continue an experiment.', '开始或继续一个实验。'], [
  ['Open the home page.', '打开主页。'],
  ['Read the step number, time, and remaining time for the experiment task.', '查看实验待办的步骤编号、时间和剩余时间。'],
  ['Select "去处理" (Open task).', '选择“去处理”。'],
  ['Record the work in the experiment step.', '在实验步骤中记录操作。'],
  ['Complete the step when the actual work is complete.', '实际操作完成后，将该步骤标记完成。']
], ['SciHub updates the experiment task from the saved progress.', 'SciHub 根据已保存的进度更新实验待办。'], [
  ['Automatic tasks have no manual delete button.', '自动实验待办没有手动删除按钮。'],
  ['Time reminders are estimates from the plan and recorded times.', '计时提醒根据方案和记录时间估算。'],
  ['A duration marked "待确认" does not produce an automatic end time.', '标为“待确认”的时长不生成自动结束时间。'],
  ['SciHub does not send system alarms when the page is closed.', '关闭页面后，SciHub 不会发送系统闹钟通知。']
]);
p('record-new', 'records', 'Create a research record', '新建科研记录', ['Log in.', '先登录。'], [
  ['Select "科研记录" (Research records).', '选择“科研记录”。'],
  ['Select "＋ 新建记录" (New record).', '选择“＋ 新建记录”。'],
  ['Enter the title.', '填写标题。'],
  ['Select the category and date.', '选择类别和日期。'],
  ['If necessary, enter tags with English commas between the tags.', '如有需要，填写标签并用英文逗号分隔。'],
  ['Enter the record content.', '填写记录内容。'],
  ['Select "保存" (Save).', '选择“保存”。'],
  ['Wait for "记录已创建" (Record created).', '等待“记录已创建”的提示。']
], ['The saved record appears in the list.', '已保存的记录出现在列表中。'], [
  ['Categories include experiment logs, literature notes, characterization data, results, tasks, and other records.', '类别包括实验日志、文献笔记、表征数据、结果分析、待办和其他。']
]);
p('record-edit', 'records', 'Edit a research record', '编辑科研记录', ['Open "科研记录".', '打开“科研记录”。'], [
  ['Find the record.', '找到记录。'],
  ['Select its "编辑" (Edit) button.', '选择该记录的“编辑”按钮。'],
  ['Change the necessary fields.', '修改需要调整的字段。'],
  ['Select "保存" (Save).', '选择“保存”。'],
  ['Wait for "记录已更新" (Record updated).', '等待“记录已更新”的提示。']
], ['SciHub shows the updated record.', 'SciHub 显示更新后的记录。'], [
  ['Select "取消" to close the form and discard its changes.', '选择“取消”可关闭表单并放弃表单中的修改。'],
  ['An edited experiment log does not change the original experiment step records.', '修改实验日志正文不会改变原始实验步骤记录。']
]);
p('record-find', 'records', 'Find research records', '搜索和筛选记录', ['Open "科研记录".', '打开“科研记录”。'], [
  ['Enter text in "搜索标题 / 内容 / 标签".', '在“搜索标题 / 内容 / 标签”中输入文字。'],
  ['Select a category if necessary.', '如有需要，选择类别。'],
  ['Read the records that match both conditions.', '查看同时符合搜索和类别条件的记录。'],
  ['Clear the search text to remove the text filter.', '清空搜索文字以取消文字筛选。'],
  ['Select "全部类别" to remove the category filter.', '选择“全部类别”以取消类别筛选。']
], ['The count shows the number of matching records.', '计数显示匹配记录的数量。']);
p('record-export', 'records', 'Export research records to CSV', '导出科研记录为 CSV', ['Open "科研记录".', '打开“科研记录”。'], [
  ['Set the search and category filters that you need.', '设置需要的搜索和类别条件。'],
  ['Check the matching records.', '检查匹配的记录。'],
  ['Select "导出" (Export).', '选择“导出”。'],
  ['Open the downloaded CSV file with a spreadsheet application.', '用电子表格软件打开下载的 CSV 文件。']
], ['The file contains the records in the current filter.', '文件包含当前筛选出的记录。'], [
  ['CSV export does not include experiment attachments or a complete database backup.', 'CSV 导出不包含实验附件，也不是完整数据库备份。']
]);
p('record-delete', 'records', 'Delete a research record', '删除科研记录', ['Save an export if you must keep a copy.', '如果需要保留副本，先导出保存。'], [
  ['Find the record in "科研记录".', '在“科研记录”中找到该记录。'],
  ['Select its "删除" (Delete) button.', '选择该记录的“删除”按钮。'],
  ['Read the confirmation message.', '阅读确认提示。'],
  ['Confirm only if the record is the correct record.', '只有确认对象正确时才确认删除。']
], ['The record no longer appears after a successful delete.', '删除成功后，记录不再出现在列表中。'], [], [
  ['Deletion is permanent; SciHub has no record recycle bin.', '删除无法撤销；SciHub 没有记录回收站。'],
  ['If you delete a generated log, its experiment remains.', '删除生成的日志后，对应实验仍然保留。']
]);
p('plan-import', 'plans', 'Import a Word plan', '导入 Word 实验方案', ['Prepare a .docx file that contains the plan.', '准备包含方案的 .docx 文件。'], [
  ['Select "实验方案" (Experiment plans).', '选择“实验方案”。'],
  ['In "导入 Word 方案", select the file.', '在“导入 Word 方案”中选择文件。'],
  ['Wait for the plan draft.', '等待方案草稿出现。'],
  ['Open "查看导入原文".', '展开“查看导入原文”。'],
  ['Compare all draft steps with the source document.', '将全部草稿步骤与原文件逐项核对。'],
  ['Correct the draft before you save it.', '保存前修正草稿。']
], ['SciHub opens "核对导入结果" (Check import results).', 'SciHub 打开“核对导入结果”。'], [
  ['AI parsing can send plan text to the configured AI service.', 'AI 解析可能把方案文本发送到配置的 AI 服务。'],
  ['The imported procedure uses Chinese instructions.', '导入后的步骤使用中文。'],
  ['If you leave before import completes, select the file again when you return.', '导入完成前若切换页面，返回后需重新选择文件。'],
  ['Keep source values, units, conditions, negative instructions, and instrument codes unchanged.', '保留原文数值、单位、条件、否定指令及仪器代码，不擅自更改。'],
  ['Check all operations, conditions, and data fields against the source.', '对照原文核对全部操作、条件和记录项。'],
  ['An unnumbered source needs manual process boundaries before you save.', '无编号原文须在保存前手工核对并划分工序。'],
  ['PDF, .doc, and image imports are not available.', '目前不支持 PDF、.doc 和图片导入。']
]);
p('plan-review', 'plans', 'Check and save a plan draft', '核对并保存方案草稿', ['Open an imported draft or select "编辑方案".', '打开导入草稿，或选择“编辑方案”。'], [
  ['Check the plan name.', '核对方案名称。'],
  ['Check each step title, instruction, and time hint.', '核对每步的标题、说明和时长提示。'],
  ['Check the field names, units, and input types.', '核对字段名称、单位和填写方式。'],
  ['Check the notices and pyrolysis program.', '核对注意事项和热解程序。'],
  ['Resolve each "待确认" item from your approved source.', '根据已确认的原文件，逐项处理“待确认”内容。'],
  ['Select "保存方案" or "保存修改".', '选择“保存方案”或“保存修改”。'],
  ['If empty rows remain, read the confirmation before you continue.', '如果存在空白行，先阅读确认提示再继续。'],
  ['Wait for the successful save message.', '等待保存成功提示。']
], ['SciHub opens the saved plan preview.', 'SciHub 打开已保存方案的预览页。'], [
  ['Do not use the same field name twice in one step.', '同一步中不要重复使用同一字段名。'],
  ['Empty unnamed field rows do not become saved fields.', '没有名称的空白字段行不会保存为字段。'],
  ['Select "取消" to discard the draft changes.', '选择“取消”放弃草稿修改。'],
  ['Cancel an existing plan edit to return to its preview.', '取消已有方案编辑后，返回该方案的预览页。']
], [
  ['Plan edits can update compatible steps in active experiments.', '修改方案可能同步更新进行中实验中可安全对应的步骤。'],
  ['If the step structure changes, check the message about the retained experiment snapshot.', '步骤结构变化时，检查关于保留实验快照的提示。']
]);
p('plan-edit', 'plans', 'Open and edit a plan', '查看并编辑方案', ['A saved plan must exist.', '需要已有保存的方案。'], [
  ['Select the plan card on the home page or plan list.', '在主页或方案列表中选择方案卡片。'],
  ['Read the steps and the dated change log.', '阅读步骤和按日期记录的更新日志。'],
  ['Select "编辑方案" (Edit plan).', '选择“编辑方案”。'],
  ['Change the draft.', '修改草稿。'],
  ['Use the draft check procedure before you save.', '保存前执行草稿核对流程。']
], ['SciHub saves the new plan definition and returns to its preview.', 'SciHub 保存新的方案定义，并返回该方案的预览页。']);
p('plan-blocks', 'plans', 'Add fields and step content', '添加步骤、字段和板块', ['Open a plan draft.', '打开方案草稿。'], [
  ['Select "＋ 添加步骤" if you need another step.', '需要新增步骤时，选择“＋ 添加步骤”。'],
  ['In a step, open "＋ 添加板块".', '在某一步中展开“＋ 添加板块”。'],
  ['Select "＋ 数据字段", "＋ 注意事项", or "＋ 热解程序".', '选择“＋ 数据字段”、“＋ 注意事项”或“＋ 热解程序”。'],
  ['Enter the new content.', '填写新内容。'],
  ['For a data field, select its input type.', '为数据字段选择填写方式。'],
  ['Check the draft before you save.', '保存前核对草稿。']
], ['The new content becomes part of the saved plan.', '新内容成为已保存方案的一部分。'], [
  ['Input types are text, number, checkbox, time, date, and date with time.', '填写方式包括文本、数字、勾选已完成、时间、日期和日期加时间。'],
  ['The default pyrolysis program is an example; replace it with the correct program.', '默认热解程序只是示例，须换成实际正确的程序。']
]);
p('plan-order', 'plans', 'Move or remove draft content', '调整顺序或移除草稿内容', ['Open a plan draft.', '打开方案草稿。'], [
  ['On a computer, move a drag handle to change the step order.', '在电脑上，拖动手柄调整步骤顺序。'],
  ['Move a field or notice handle to change its order within the same step.', '拖动字段或注意事项的手柄，调整同一步内的顺序。'],
  ['To remove a row, select the × button for that row.', '移除某一行时，选择该行的 × 按钮。'],
  ['To remove a step, select "删除步骤" (Delete step).', '移除某一步时，选择“删除步骤”。'],
  ['Compare the remaining draft with the source document.', '将剩余草稿与原文件核对。'],
  ['Save only after the draft is correct.', '仅在草稿正确后保存。']
], ['The saved plan uses the order and content that you checked.', '保存后的方案使用已核对的顺序和内容。'], [
  ['Use the plan card menu to delete a saved plan.', '删除已保存方案时，使用方案卡片菜单。']
], [
  ['Draft remove buttons do not request confirmation for each row.', '草稿移除按钮不会对每一行分别弹出确认。'],
  ['Keep a copy before you remove content that an active experiment uses.', '移除进行中实验使用的内容前，先保留副本。']
]);
p('plan-version', 'plans', 'Upload a new plan version', '上传方案新版本', ['Prepare the new .docx file.', '准备新版 .docx 文件。'], [
  ['Open the saved plan.', '打开已保存方案。'],
  ['Select "上传新版本" (Upload new version).', '选择“上传新版本”。'],
  ['Select the new .docx file.', '选择新版 .docx 文件。'],
  ['Check the new, retained, and manually added steps in the draft.', '核对草稿中新增、保留以及手动添加的步骤。'],
  ['Correct the field names, units, and conditions.', '修正字段名称、单位和条件。'],
  ['Compare the Chinese instructions with "查看导入原文".', '对照“查看导入原文”核对中文指令。'],
  ['Select "保存修改" (Save changes).', '选择“保存修改”。'],
  ['Read the save and experiment synchronization messages.', '阅读保存和实验同步提示。']
], ['The dated plan log identifies the saved update.', '按日期记录的方案日志标识此次更新。'], [
  ['A change log entry is not a complete restorable copy of an old plan.', '更新日志条目并不是可完整恢复的旧方案副本。']
], [
  ['Do not assume that every active experiment changed with the plan.', '不要假定全部进行中实验都已随方案更新。'],
  ['A blocked structural change keeps the old experiment snapshot.', '无法安全同步的结构变化会保留原实验快照。'],
  ['If a step match is uncertain, check the retained old steps and the new steps.', '步骤对应关系不确定时，核对保留的旧步骤及新增步骤。']
]);
p('plan-rename', 'plans', 'Rename a plan', '重命名方案', ['Open the home page or plan list.', '打开主页或方案列表。'], [
  ['Right-click the plan card, or hold the card on a phone.', '在方案卡片上右键，或在手机上长按卡片。'],
  ['Select "重命名" (Rename).', '选择“重命名”。'],
  ['Enter the new plan name.', '填写新的方案名称。'],
  ['Select "保存名称" (Save name).', '选择“保存名称”。'],
  ['Check the plan list.', '检查方案列表。']
], ['SciHub changes the plan name.', 'SciHub 更改方案名称。'], [
  ['Existing experiment titles have their own rename control.', '既有实验的名称使用独立的重命名入口。'],
  ['For keyboard access, focus the card and press Shift+F10.', '使用键盘时，将焦点移到卡片，再按 Shift+F10。'],
  ['Press Escape to close the menu.', '按 Escape 关闭菜单。']
]);
p('plan-delete', 'plans', 'Delete a saved plan', '删除已保存方案', ['Open the home page or plan list.', '打开主页或方案列表。'], [
  ['Right-click the plan card, or hold the card on a phone.', '在方案卡片上右键，或在手机上长按卡片。'],
  ['Select "删除" (Delete).', '选择“删除”。'],
  ['Read the plan name and deletion effects in the confirmation.', '阅读确认框中的方案名称及删除影响。'],
  ['Cancel if you selected the wrong plan.', '选错方案时取消操作。'],
  ['Select "确认删除" only if you want to delete this plan.', '仅在确定删除此方案时，选择“确认删除”。'],
  ['Wait for the deletion result and check the plan cards.', '等待删除结果，并检查方案卡片。']
], ['SciHub removes the plan definition and retains existing experiment snapshots.', 'SciHub 移除方案定义，并保留既有实验快照。'], [
  ['Existing experiments retain their steps, measured values, notes, and attachment references.', '既有实验保留步骤、实测值、备注及附件引用。'],
  ['A deleted plan is no longer available for new experiments.', '删除的方案不能再用于开始新实验。'],
  ['If deletion fails, keep the page and read the error before retrying.', '删除失败时保留页面，阅读错误后再重试。'],
  ['A plan cannot be deleted while a locked merged branch still uses it.', '已合并的只读支路仍使用此方案时，无法删除方案。']
], [
  ['Deletion cannot be undone; there is no plan recycle bin.', '删除无法撤销；目前没有方案回收站。'],
  ['Deletion also removes the saved plan steps.', '删除会同时移除已保存的方案步骤。'],
  ['Keep the original document before you delete a plan.', '删除方案前保留原文件。']
]);
p('plan-reparse', 'plans', 'Update an old plan parser result', '更新旧方案的解析结果', ['The plan must show "有新版本" or "重新解析".', '方案须显示“有新版本”或“重新解析”。'], [
  ['Keep a copy of the current plan and experiment data.', '保留当前方案和实验数据的副本。'],
  ['Select "更新" in the plan list or "重新解析" in the plan details.', '在方案列表选择“更新”，或在详情中选择“重新解析”。'],
  ['Read any request to transfer field values in active experiments.', '阅读关于迁移进行中实验字段值的请求。'],
  ['Confirm a transfer only after you check the field meanings and units.', '核对字段含义和单位后，才确认迁移。'],
  ['Read the result message.', '阅读结果提示。'],
  ['Check the updated plan fields and affected experiment values.', '检查更新后的方案字段和受影响的实验值。']
], ['SciHub updates the plan steps and fields.', 'SciHub 更新方案步骤和字段。'], [
  ['Parser updates and website updates are different operations.', '方案解析更新与网站版本更新是不同操作。']
], [
  ['A parser update can change field definitions; do not treat it as a preview.', '解析更新可能更改字段定义，不能把它当作只读预览。']
]);
p('plan-restore', 'plans', 'Restore missing plan steps', '恢复缺失的方案步骤', ['The saved plan must have no steps.', '已保存方案须处于没有步骤的状态。'], [
  ['Open the plan.', '打开方案。'],
  ['Select "从实验快照恢复步骤" (Restore steps from experiment snapshot).', '选择“从实验快照恢复步骤”。'],
  ['Read the name of the source experiment.', '阅读作为来源的实验名称。'],
  ['Compare the restored draft with your original plan.', '将恢复的草稿与原方案核对。'],
  ['Correct the draft if necessary.', '必要时修正草稿。'],
  ['Select "保存修改" (Save changes).', '选择“保存修改”。']
], ['SciHub restores the checked step definitions.', 'SciHub 恢复已核对的步骤定义。'], [
  ['SciHub selects the experiment with the most saved steps.', 'SciHub 选择已保存步骤数量最多的实验作为来源。'],
  ['Restoration copies definitions; it does not copy measured values into the plan.', '恢复复制步骤定义，不把实测值复制进方案。'],
  ['If no snapshot exists, use "上传新版本" with the original .docx file.', '如果没有快照，使用“上传新版本”导入原 .docx 文件。']
]);
p('run-start', 'runs', 'Start an experiment', '开始一次实验', ['Check and save the plan first.', '先核对并保存方案。'], [
  ['Open the plan details.', '打开方案详情。'],
  ['Select "开始实验" (Start experiment).', '选择“开始实验”。'],
  ['Wait for the experiment page.', '等待实验页出现。'],
  ['Check the experiment title and first step.', '核对实验名称和第一步。']
], ['SciHub creates a separate experiment with a plan snapshot.', 'SciHub 创建带方案快照的独立实验。'], [
  ['Each start creates another experiment; do not use it to resume an existing experiment.', '每次开始会创建另一次实验，不要用此按钮恢复既有实验。'],
  ['If preparation fails, check the message before you try again.', '准备失败时，先核对提示再重试。']
]);
p('run-resume', 'runs', 'Continue or browse an experiment', '继续实验或浏览步骤', ['Open the home page.', '打开主页。'], [
  ['Find the experiment in "进行中的实验".', '在“进行中的实验”中找到目标实验。'],
  ['Select "继续" (Continue).', '选择“继续”。'],
  ['Read the saved progress and last save time.', '查看已保存进度和上次保存时间。'],
  ['Select a numbered step to read that step.', '选择步骤编号以查看该步。'],
  ['Use "上一步" to read the previous step if necessary.', '如有需要，使用“上一步”查看前一步。']
], ['SciHub shows the selected step; it does not mark that step complete.', 'SciHub 显示所选步骤，不会仅因浏览就标记完成。'], [
  ['Browsing a step does not change recorded progress.', '浏览步骤不会改变已记录进度。'],
  ['Progress uses the last step with values, notes, attachments, or checked items.', '进度以最后一个有有效值、备注、附件或已勾选条目的步骤为准。'],
  ['An experiment without input shows "尚未记录".', '没有填写信息的实验显示“尚未记录”。']
]);
p('run-data', 'runs', 'Record step data', '填写步骤数据', ['Open an active experiment step.', '打开进行中实验的某一步。'], [
  ['Read the instruction and notices before the laboratory work.', '实验操作前阅读说明和注意事项。'],
  ['Enter the actual values in the named fields.', '在对应字段中填写实际值。'],
  ['Use the date and time controls when the field requires them.', '字段需要日期或时间时，使用对应选择器。'],
  ['Select a checkbox only after its actual operation is complete.', '仅在实际操作完成后勾选对应条目。'],
  ['Enter observations and exceptions in "备注" (Notes).', '在“备注”中填写现象和异常。'],
  ['Stop text input and wait for the saved status.', '停止输入并等待已保存状态。']
], ['SciHub saves the values and notes for this step.', 'SciHub 保存该步的数据和备注。'], [
  ['SciHub normally starts a save about one second after input stops.', '通常在停止输入约一秒后开始保存。'],
  ['A zero value is a value; leave an unknown value empty.', '零是有效值；未知值应留空。'],
  ['Empty fields and automatic start times do not advance recorded progress.', '空字段和自动开始时间不会增加已记录进度。'],
  ['A completion status remains protected even without measured values.', '即使没有测量值，完成状态仍受保护。']
], [
  ['An input on the screen is not proof of a successful cloud save.', '屏幕上已有输入不代表云端已保存成功。']
]);
p('run-next', 'runs', 'Complete a step', '完成一步并继续', ['Complete the actual work and check the saved data.', '完成实际操作，并核对已保存的数据。'], [
  ['Select "完成并下一步" (Complete step and continue).', '选择“完成并下一步”。'],
  ['Wait for the next step.', '等待下一步出现。'],
  ['Check the step number and saved progress.', '核对步骤编号和已保存进度。']
], ['SciHub marks the previous step complete after a successful save.', '保存成功后，SciHub 将前一步标记完成。'], [
  ['If a save fails, keep the page open and correct the error.', '保存失败时，保留页面并处理错误。']
]);
p('run-sync', 'runs', 'Check a plan difference', '处理方案与实验的差异', ['An independent experiment must show "与方案不一致".', '独立实验须显示“与方案不一致”。'], [
  ['Read each listed difference.', '阅读全部差异。'],
  ['Keep an export of the experiment before structural changes.', '结构变更前保留实验导出副本。'],
  ['Select "立即同步" only if the updated definition applies to this experiment.', '仅在新版定义适用于本次实验时，选择“立即同步”。'],
  ['Read the result message.', '阅读结果提示。'],
  ['Check the field meanings, values, and step order again.', '再次核对字段含义、数据和步骤顺序。']
], ['A safe synchronization updates compatible definitions and keeps the saved values.', '安全同步更新可对应的定义，并保留已保存值。'], [
  ['Merged experiment definitions are locked and do not offer plan synchronization.', '已合并实验的定义锁定，不提供方案同步。']
], [
  ['If SciHub cannot match the structure safely, keep the original snapshot.', '如果 SciHub 无法安全匹配结构，保留原始快照。']
]);
p('run-extra', 'runs', 'Remove extra experiment steps', '移除实验中多余的步骤', ['Read the difference list and keep a complete export.', '先阅读差异列表并保留完整导出副本。'], [
  ['Select "删掉多余的 … 步" only if those steps are incorrect.', '仅在多余步骤确实不应保留时，选择“删掉多余的 … 步”。'],
  ['Read the listed values, notes, and attachment counts.', '阅读列出的值、备注和附件数量。'],
  ['Cancel if any listed step must remain.', '任何列出的步骤仍需保留时，取消操作。'],
  ['Confirm only after you check every listed step.', '逐项核对列出的步骤后，才确认。'],
  ['Read the result message.', '阅读结果提示。']
], ['SciHub removes the selected extra step records after confirmation.', '确认后，SciHub 移除相应多余步骤记录。'], [], [
  ['This operation can permanently remove recorded values and attachment references.', '此操作可能永久移除已记录值和附件引用。']
]);
p('run-finish', 'runs', 'Finish an experiment', '完成实验并生成日志', ['Complete the actual work and all necessary step records.', '完成实际实验工作和全部必要步骤记录。'], [
  ['Open the last step.', '打开最后一步。'],
  ['Check the values, notes, and attachment save status.', '核对数据、备注和附件保存状态。'],
  ['Select "完成实验" (Finish experiment).', '选择“完成实验”。'],
  ['Read and confirm the completion request.', '阅读并确认完成请求。'],
  ['Wait for "实验已完成，日志已保存到科研记录".', '等待“实验已完成，日志已保存到科研记录”的提示。'],
  ['Open "科研记录" to read the generated experiment log.', '打开“科研记录”查看生成的实验日志。']
], ['The experiment becomes read-only after successful completion.', '成功完成后，实验变为只读。'], [
  ['A merged experiment requires every common step to be complete.', '合并实验要求全部共同步骤已完成。'],
  ['There is no reopen control for a completed experiment.', '目前没有重新打开已完成实验进行编辑的入口。']
], [
  ['If completion is not confirmed, check the saved status before you repeat the request.', '如果完成状态未确认，先核对已保存状态再重试。']
]);
p('run-rename', 'runs', 'Rename an active experiment', '重命名进行中的实验', ['Find the active experiment card on the home page.', '在主页找到进行中的实验卡片。'], [
  ['Select the "重命名" (Rename) icon.', '选择“重命名”图标。'],
  ['Enter the new experiment name.', '输入新的实验名称。'],
  ['Confirm the name.', '确认名称。'],
  ['Check the updated card.', '核对更新后的卡片。']
], ['SciHub changes this experiment title, not the plan title.', 'SciHub 更改本次实验名称，方案名称不变。']);
p('run-delete', 'runs', 'Delete an independent experiment', '删除独立实验', ['Keep the record and attachment copies that you need.', '保留需要的记录和附件副本。'], [
  ['Find the independent experiment card on the home page.', '在主页找到独立实验卡片。'],
  ['Select "删除这次实验" (Delete experiment).', '选择“删除这次实验”。'],
  ['Read the permanent deletion message.', '阅读永久删除提示。'],
  ['Confirm only if this is the correct experiment.', '仅在目标实验正确时确认。'],
  ['Read the result and any attachment cleanup warning.', '阅读结果以及可能出现的附件清理提示。']
], ['SciHub removes the experiment and its step records after a successful delete.', '删除成功后，SciHub 移除该实验及其步骤记录。'], [
  ['A merged branch or common stage cannot use this delete procedure.', '已合并支路或共同阶段不能使用此删除流程。'],
  ['A generated research log is a separate record.', '已生成的科研日志是独立记录。']
], [
  ['This operation can permanently delete experiment values and cloud attachments.', '此操作可能永久删除实验数据和云端附件。']
]);
p('run-export', 'runs', 'Export an experiment to Word', '导出实验为 Word', ['Open the experiment or its home page card.', '打开实验，或找到主页上的实验卡片。'], [
  ['Select "导出 Word" or the "导出" document icon.', '选择“导出 Word”或“导出”文档图标。'],
  ['Wait for the .docx download.', '等待 .docx 文件下载。'],
  ['Open the file.', '打开文件。'],
  ['Check the step data and any unavailable image notices.', '检查步骤数据和无法读取图片的提示。'],
  ['Save video attachments separately if you need them.', '需要视频时，单独保存视频附件。']
], ['The document contains saved step data and available images.', '文档包含已保存的步骤数据和可读取的图片。'], [
  ['An active export follows recorded progress and also keeps explicit completion records.', '进行中实验按实际记录进度导出，并保留明确的完成记录。'],
  ['A merged export lists each separate branch and the common stage once.', '合并实验导出分别列出各支路，并只列一次共同阶段。'],
  ['Word exports identify video files but do not embed them.', 'Word 导出列出视频文件信息，但不嵌入视频。'],
  ['An export is not a complete database backup.', '导出文件不是完整数据库备份。']
]);
p('media-add', 'media', 'Add photographs or videos', '上传照片或视频', ['Open an editable experiment step.', '打开可编辑的实验步骤。'], [
  ['Select "拍照 / 录像" or "相册多选".', '选择“拍照 / 录像”或“相册多选”。'],
  ['Use the device file panel to select the correct media.', '通过设备文件面板选择正确的媒体。'],
  ['Wait for the upload count and saved status.', '等待上传数量和保存状态。'],
  ['Make sure that each expected thumbnail appears in the correct step.', '确认每个预期缩略图都出现在正确步骤中。']
], ['SciHub attaches the uploaded media to that step.', 'SciHub 将上传媒体附到该步。'], [
  ['Available camera controls depend on the device and browser.', '可用拍摄选项取决于设备和浏览器。'],
  ['SciHub can compress large photographs; keep the original files separately.', 'SciHub 可能压缩大图，应另外保留原文件。']
], [
  ['If only some files upload, check the count before you select the files again.', '如果只有部分上传成功，重新选择文件前先核对数量。'],
  ['Do not refresh while an upload or attachment save is incomplete.', '上传或附件保存未完成时，不要刷新页面。']
]);
p('media-caption', 'media', 'Add media captions and change media order', '编辑附件注解和顺序', ['Open an editable step with media.', '打开带附件的可编辑步骤。'], [
  ['Enter a caption below the correct thumbnail.', '在正确缩略图下填写注解。'],
  ['Wait for the saved status.', '等待已保存状态。'],
  ['On a computer, move a thumbnail to the required position.', '在电脑上，拖动缩略图到需要的位置。'],
  ['On a phone, press and hold a thumbnail before you move it.', '在手机上，长按缩略图后再拖动。'],
  ['Wait for the order to save.', '等待顺序保存。']
], ['The step and Word export use the saved media order.', '步骤页面和 Word 导出使用已保存的附件顺序。']);
p('media-read', 'media', 'View and save media to your device', '查看附件并保存到设备', ['Open a step with saved media.', '打开带有已保存附件的步骤。'], [
  ['Select a thumbnail to open the full view.', '选择缩略图以打开完整视图。'],
  ['For a video, use its playback controls.', '视频使用播放器控制按钮。'],
  ['Use the arrows to select another attachment.', '使用箭头选择其他附件。'],
  ['Select "存到相册" (Save to album) to save the current attachment.', '选择“存到相册”保存当前附件。'],
  ['If the system share panel opens, select its save option.', '如果系统分享面板打开，选择其中的保存选项。'],
  ['If a file downloads, find it in the download folder.', '如果文件下载，前往下载文件夹查看。'],
  ['Select × or press Escape to close the full view.', '选择 × 或按 Escape 关闭完整视图。']
], ['You can read the attachment or keep a device copy.', '可以查看附件或保留设备副本。'], [
  ['On a computer, the left and right arrow keys also select attachments.', '电脑上也可使用左右方向键切换附件。'],
  ['Device album access depends on browser support.', '保存到设备相册的能力取决于浏览器支持。']
]);
p('media-delete', 'media', 'Delete a step attachment', '删除步骤附件', ['Keep an original copy if you need the attachment.', '如果仍需保留附件，先保存原始副本。'], [
  ['Open the editable step.', '打开可编辑步骤。'],
  ['Select × on the correct attachment.', '选择正确附件上的 ×。'],
  ['Read the confirmation message.', '阅读确认提示。'],
  ['Confirm only if the attachment is correct.', '仅在附件对象正确时确认。'],
  ['Read the result and any cloud cleanup warning.', '阅读结果及可能出现的云端清理提示。']
], ['SciHub removes the attachment reference after a successful save.', '保存成功后，SciHub 移除附件引用。'], [], [
  ['The operation also attempts to delete the cloud file.', '该操作还会尝试删除云端文件。'],
  ['Completed experiments and merged branches have no editable attachment controls.', '已完成实验和已合并支路的附件控件不可编辑。']
]);
p('merge-prepare', 'merge', 'Prepare parallel experiments', '准备平行实验合并', ['Use 2 to 8 separate active experiments under the same account.', '使用同一账号下 2 至 8 个独立进行中实验。'], [
  ['Check that all step definitions are the same in every experiment.', '核对每个实验的全部步骤定义一致。'],
  ['Check step order, titles, instructions, fields, units, notices, times, and pyrolysis conditions.', '核对顺序、标题、说明、字段、单位、注意事项、时长和热解条件。'],
  ['Select the last separate step as the mixing boundary.', '选择最后一个独立执行的步骤作为混合边界。'],
  ['Complete every step through that boundary in each experiment.', '在每个实验中完成截至该边界的全部步骤。'],
  ['Keep all later steps empty and incomplete.', '保持后续步骤无记录且未完成。']
], ['The experiments can enter the merge review.', '实验可以进入合并审核。'], [
  ['Measured values can differ; plan definitions must match.', '实测值可以不同，方案定义必须一致。'],
  ['Unit case matters: M and m are different.', '单位大小写有意义，M 与 m 不等同。'],
  ['At least one separate step and one common step must remain.', '至少保留一个前置独立步骤和一个后续共同步骤。'],
  ['Browsing later steps with empty fields does not prevent a merge.', '仅浏览后续空白步骤不会阻止合并。']
]);
p('merge-review', 'merge', 'Review and confirm a merge', '审核并确认混合合并', ['Complete the parallel experiment preparation procedure.', '先完成平行实验合并准备流程。'], [
  ['Open one experiment.', '打开其中一个实验。'],
  ['Select "＋ 合并平行实验".', '选择“＋ 合并平行实验”。'],
  ['Select the other experiments in the merge window.', '在合并窗口中选择其他实验。'],
  ['Select the step after which you will mix the samples.', '选择完成哪一步后混合样品。'],
  ['Select "审核合并条件" (Review merge conditions).', '选择“审核合并条件”。'],
  ['Wait for "审核通过" (Review passed).', '等待“审核通过”。'],
  ['Enter the sample identifiers and mixing operation in "合并说明".', '在“合并说明”中填写样品标识和混合操作。'],
  ['Select the checkbox that confirms the records and mixing boundary.', '勾选确认记录和混合边界的确认框。'],
  ['Select "确认混合并创建共同阶段".', '选择“确认混合并创建共同阶段”。'],
  ['Wait for the common stage page.', '等待共同阶段页面出现。']
], ['Each branch keeps its original data; one new stage owns the later records.', '各支路保留原数据，新共同阶段单独保存后续记录。'], [
  ['The home page merge icon opens the same review window.', '主页合并图标可打开同一审核窗口。'],
  ['If selected experiments or data change after review, repeat the review.', '审核后选择或数据发生变化时，需要重新审核。'],
  ['SciHub checks the merge again when you submit.', '提交时再次检查合并条件。'],
  ['Later values, notes, attachments, or checked items prevent a merge.', '后续步骤已有值、备注、附件或已勾选条目时，不能合并。'],
  ['A completion marker without input shows a warning; confirm that it is not a later operation record.', '只有完成标记而没有填写内容时显示警告；请确认它不是实际的后续操作记录。'],
  ['Keep unexpected stored records and check them before a merge.', '保留异常历史记录，核对清楚后再合并。']
], [
  ['A confirmed mix locks the original branches.', '确认混合后，原支路锁定。'],
  ['There is no direct split or delete operation for a confirmed merged chain.', '已确认合并的链路没有直接拆分或删除操作。'],
  ['The operator must confirm the records and mixing boundary after the checks pass.', '检查通过后，操作者须确认记录和混合边界。']
]);
p('merge-use', 'merge', 'Use the branch and common stage diagram', '查看支路和共同阶段流程图', ['Open a merged experiment.', '打开合并实验。'], [
  ['Select a branch card to read its original data.', '选择支路卡片查看原始数据。'],
  ['Select the common stage card to record later steps.', '选择共同阶段卡片记录后续步骤。'],
  ['On a phone, move the diagram left or right inside its panel.', '在手机上，在流程图板块内左右滑动。'],
  ['Use the continued step numbers for the common stage.', '按延续的步骤编号使用共同阶段。'],
  ['Record each common operation only once.', '每个共同操作只记录一次。']
], ['The diagram identifies separate data and shared later data.', '流程图清楚标识独立数据与共同后续数据。'], [
  ['For a boundary after step 3, branches show steps 1–3 and the common stage starts at step 4.', '第三步后合并时，支路显示第 1–3 步，共同阶段从第 4 步开始。'],
  ['The form stays within the phone width while the diagram moves.', '流程图滑动时，填写表单仍保持手机宽度。']
]);
p('merge-history', 'merge', 'Read a completed merge', '查看已完成合并实验', ['Finish the common stage.', '先完成共同阶段。'], [
  ['Open "主页" (Home).', '打开“主页”。'],
  ['Find "最近完成的合并实验".', '找到“最近完成的合并实验”。'],
  ['Select "查看流程与完整记录".', '选择“查看流程与完整记录”。'],
  ['Use the diagram to read each branch and the common stage.', '通过流程图查看各支路和共同阶段。'],
  ['Select "导出 Word" if you need the complete merged record.', '需要完整合并记录时，选择“导出 Word”。']
], ['All branches and the completed common stage remain read-only.', '全部支路和已完成共同阶段保持只读。'], [
  ['The home page shows the five most recent completed merges.', '主页显示最近五项已完成合并实验。'],
  ['Search "科研记录" for the generated log of an older experiment.', '较早实验的自动日志可在“科研记录”中搜索。']
]);
p('merge-errors', 'merge', 'Correct a rejected merge', '处理合并审核失败', ['Keep all original experiment records.', '保留全部原始实验记录。'], [
  ['Read the specific rejection message.', '阅读具体拒绝原因。'],
  ['If a separate step is incomplete, complete the actual work first.', '前置步骤未完成时，先完成实际操作。'],
  ['If definitions differ, keep the experiments separate until you resolve the plan difference.', '定义不一致时，在方案差异得到合理解决前保持独立实验。'],
  ['If later records exist, keep them and use a separate workflow.', '后续已有记录时，保留这些记录并使用独立流程。'],
  ['If data changed after review, open the review again.', '审核后数据变化时，重新打开审核。']
], ['You preserve the evidence while you resolve the rejection.', '在处理拒绝原因的同时保留实验事实。'], [], [
  ['Do not erase actual measurements merely to pass a merge check.', '不要仅为通过合并检查而清空真实测量记录。'],
  ['A rejected merge cannot proceed.', '审核未通过时，无法继续合并。']
]);
p('legacy-links', 'merge', 'Use an old experiment association', '处理旧版实验关联', ['The experiments must already have an old association.', '实验须已有旧版关联关系。'], [
  ['Read the associated experiment card on the home page.', '在主页查看旧关联实验卡片。'],
  ['Open the separate experiment details when necessary.', '需要时打开各实验详情。'],
  ['If necessary, select "改说明" to change an old association note.', '如有需要，选择“改说明”修改旧关联说明。'],
  ['Select "导出" to retain the associated records.', '选择“导出”保留关联记录。'],
  ['If you need separate cards, select "取消关联".', '需要拆回独立卡片时，选择“取消关联”。'],
  ['Read the group names before you confirm.', '确认前阅读整组实验名称。']
], ['If you cancel an old association, its saved values and progress remain.', '取消旧关联会保留各实验的已保存数据和进度。'], [
  ['New physical mixing uses the merge review procedure.', '新的实体混合使用合并审核流程。'],
  ['SciHub blocks old associations inside a new merge.', 'SciHub 禁止将旧关联混入新合并。']
], [
  ['If you cancel an old association, the physical sample mix remains.', '取消旧关联不能撤销实际发生的样品混合。']
]);
p('pyro-tool', 'tools', 'Use the pyrolysis program calculator', '使用热解程序计算器', ['Have the approved instrument program and process conditions.', '准备已确认的仪器程序和工艺条件。'], [
  ['Select "小工具" (Tools) in the top bar.', '选择顶栏的“小工具”。'],
  ['Select "热解程序计算器" (Pyrolysis program calculator).', '选择“热解程序计算器”。'],
  ['Enter the pyrolysis program.', '输入热解程序。'],
  ['Enter the initial temperature.', '输入初始温度。'],
  ['Enter the heating rate in ℃/min.', '输入升温速率，单位为 ℃/min。'],
  ['Enter the final temperature.', '输入最终温度。'],
  ['Read the segment times and total time.', '查看各段时间和总时间。'],
  ['If you need the program in a plan, copy the program text into the plan draft.', '需要写入方案时，将程序文字复制到方案草稿。']
], ['The calculator shows estimated segment times and a program string.', '计算器显示估算的分段时间和程序串。'], [
  ['C identifies a temperature point; T identifies a time in minutes.', 'C 表示温度点，T 表示分钟数。'],
  ['If you change the temperatures or rate, the program string can change.', '更改温度或速率可能改变程序串。'],
  ['A same-temperature segment is a hold segment.', '相同温度之间的段为保温段。']
], [
  ['Check the generated program against your instrument instructions before use.', '使用前，按照仪器说明核对生成的程序。'],
  ['SciHub does not control a furnace or verify laboratory safety.', 'SciHub 不控制炉体，也不验证实验室安全。']
]);
p('tools-menu', 'tools', 'Open the calculator menu', '打开小工具菜单', ['Open SciHub.', '打开 SciHub。'], [
  ['Select "小工具" in the top bar.', '选择顶栏的“小工具”。'],
  ['Select the calculator that you need.', '选择需要的计算器。'],
  ['If available, select "返回小工具" to return to the menu.', '如果显示“返回小工具”，选择它返回菜单。'],
  ['Select "关闭" to return to the current page.', '选择“关闭”返回当前页面。']
], ['The selected calculator opens above the current page.', '所选计算器在当前页面上方打开。']);
p('platinum-tool', 'tools', 'Calculate the platinum reagent mass', '使用铂氯酸计算器', ['Have the Fe content, target molar ratio, and reagent Pt mass fraction.', '准备 Fe 含量、目标摩尔比和试剂 Pt 质量分数。'], [
  ['Select "小工具" (Tools) in the top bar.', '选择顶栏的“小工具”。'],
  ['Select "铂氯酸计算器" (Platinum reagent calculator).', '选择“铂氯酸计算器”。'],
  ['Enter the FeNC mass and select mg or g.', '输入 FeNC 用量，并选择 mg 或 g。'],
  ['Enter Fe wt% as a percentage; enter 1 for 1%.', 'Fe wt% 填百分数；1 表示 1%。'],
  ['Enter the Pt:Fe molar ratio, such as 2 or 2:1.', '输入 Pt:Fe 摩尔比，例如 2 或 2:1。'],
  ['Open "试剂参数与计算公式" and check the reagent Pt mass fraction.', '展开“试剂参数与计算公式”，核对试剂 Pt 质量分数。'],
  ['Change that percentage if your reagent has a different Pt mass fraction.', '实际试剂 Pt 质量分数不同时，修改该百分数。'],
  ['Read the required reagent mass and the intermediate Fe and Pt amounts.', '读取需加入的试剂质量，以及 Fe 和 Pt 的中间计算量。'],
  ['Record the Fe content source, reagent fraction, and actual dose in your experiment notes.', '在实验备注中记录 Fe 含量来源、试剂分数及实际投料。']
], ['The calculator updates the reagent mass in mg and g when you change an input.', '修改输入时，计算器自动更新以 mg 和 g 表示的试剂质量。'], [
  ['The default reagent Pt mass fraction is 3.80761816451526%.', '默认试剂 Pt 质量分数为 3.80761816451526%。'],
  ['The molar masses are 55.845 g/mol for Fe and 195.084 g/mol for Pt.', '摩尔质量为 Fe 55.845 g/mol、Pt 195.084 g/mol。'],
  ['Trial inputs stay in this page session; they are not saved to experiment records.', '试算输入仅保留在当前页面会话，不保存到实验记录。'],
  ['Blank or invalid inputs show a message and remove the previous result.', '缺少输入或输入无效时显示提示，不保留上次结果。']
], [
  ['Use the actual reagent Pt mass fraction, not reagent purity or an assumed acid concentration.', '使用实际试剂 Pt 质量分数，不使用试剂纯度或猜测的酸浓度。'],
  ['The result is mass; solution volume requires its density.', '结果为质量；溶液体积换算还需要密度。']
]);
p('solution-tool', 'tools', 'Calculate a solution dilution', '使用配制溶液计算器', ['Have the actual stock concentration and density from the bottle label or certificate.', '准备瓶签或证书上的实际原液浓度和密度。'], [
  ['Select "小工具" in the top bar.', '选择顶栏的“小工具”。'],
  ['Select "配制溶液计算器".', '选择“配制溶液计算器”。'],
  ['Select nitric acid or hydrochloric acid.', '选择硝酸或盐酸。'],
  ['Enter the target concentration in mol/L.', '输入目标浓度，单位为 mol/L。'],
  ['Enter the final volume and select mL or L.', '输入最终配制体积，并选择 mL 或 L。'],
  ['Select the stock concentration format: mass percentage or molar concentration.', '选择原液浓度形式：质量分数或摩尔浓度。'],
  ['Enter the actual stock concentration and density.', '填写实际原液浓度和密度。'],
  ['Scroll down to read the required stock volume and mass.', '向下滚动，读取需加入原液的体积和质量。'],
  ['Record the stock parameters and actual dose in your experiment notes.', '在实验备注中记录原液参数和实际加入量。']
], ['The calculator shows the required stock volume in mL and mass in g.', '计算器显示需加入原液的体积，单位为 mL，以及质量，单位为 g。'], [
  ['Reference presets are 65% and 1.40 g/mL for nitric acid, and 37% and 1.19 g/mL for hydrochloric acid.', '参考预设：硝酸 65%、1.40 g/mL；盐酸 37%、1.19 g/mL。'],
  ['Check the concentration, density, and applicable temperature against the bottle label or certificate.', '按瓶签或证书核对浓度、密度和适用温度。'],
  ['Changing the reagent restores its reference parameters and clears its molar concentration input.', '切换试剂会恢复其参考参数，并清空原液摩尔浓度输入。'],
  ['Blank, invalid, or excessive target concentrations remove the previous result and show a message.', '缺少输入、输入无效或目标浓度过高时，不保留上次结果并显示提示。'],
  ['Trial inputs stay in this page session and do not change experimental records.', '试算输入保留在当前页面会话，不改动实验记录。']
], [
  ['Slowly add acid to water, allow cooling, then make up to the final volume.', '缓慢将酸加入水中，冷却后定容至目标体积。'],
  ['Do not add water to concentrated acid.', '不要将水加入浓酸。'],
  ['Do not calculate the water dose by subtracting the stock volume from the final volume.', '加水量不能直接用最终体积减去原液体积。']
]);
p('pyro-step', 'tools', 'Read a calculator inside an experiment step', '查看步骤中的热解计算器', ['Open a step that contains a pyrolysis program.', '打开包含热解程序的步骤。'], [
  ['Expand "热解程序计算器".', '展开“热解程序计算器”。'],
  ['Read the program and temperature values.', '查看程序和温度值。'],
  ['If the step is editable, enter trial values as necessary.', '步骤可编辑时，可按需要填写试算值。'],
  ['Read the calculated times.', '查看计算时间。'],
  ['Record actual instrument conditions in the step fields or notes.', '在步骤字段或备注中记录实际仪器条件。']
], ['You can compare estimated times with the actual process.', '可以比较估算时间和实际工艺。'], [
  ['Calculator trial inputs do not automatically become saved experimental measurements.', '计算器试算输入不会自动成为已保存的实验测量值。']
]);
p('save-recovery', 'support', 'Keep data after a save error', '保存失败时保护数据', ['Keep the page with the unsaved input open.', '保留有未保存输入的页面。'], [
  ['Read the save error.', '阅读保存错误。'],
  ['Keep a private copy of the unsaved values and notes.', '私下保存未保存值和备注的副本。'],
  ['Restore the network connection if necessary.', '必要时恢复网络连接。'],
  ['For a step save, try a normal navigation action that requests a save.', '步骤保存失败时，尝试会触发保存的正常导航操作。'],
  ['If the error identifies a version conflict, compare the other device data before you reload.', '如果错误指出版本冲突，刷新前先核对其他设备的数据。'],
  ['Restore only the correct unsaved changes after you compare both copies.', '比较两份副本后，只补回正确的未保存修改。'],
  ['Make sure that the saved status appears.', '确认出现已保存状态。']
], ['You can retry and keep the original input.', '可以重试并保留原始输入。'], [
  ['Plan drafts and research record forms require their Save button.', '方案草稿和科研记录表单须使用各自的保存按钮。'],
  ['SciHub has no separate retry-save button.', 'SciHub 没有单独的重试保存按钮。']
], [
  ['Do not reload, close, or log out while data is unsaved.', '数据未保存时，不要刷新、关闭页面或退出登录。'],
  ['Avoid simultaneous edits of the same step on two devices.', '避免在两个设备上同时编辑同一步。']
]);
p('update', 'support', 'Update SciHub and this guide', '更新 SciHub 和教程', ['Make sure that all experiment changes are saved.', '确认实验修改全部已保存。'], [
  ['Read the version in the SciHub footer.', '查看 SciHub 页脚的版本。'],
  ['If "有新版本，点击更新" appears, select that button.', '出现“有新版本，点击更新”时，选择该按钮。'],
  ['Wait for the page to reload.', '等待页面重新加载。'],
  ['Make sure that the new version appears in the footer.', '确认页脚显示新版本。'],
  ['Open "使用教程" for the current guide.', '打开“使用教程”查看当前教程。'],
  ['If the guide shows an update link, select it to load the current guide.', '教程显示更新链接时，选择它加载当前教程。']
], ['The website and guide identify their own loaded versions.', '网站和教程分别标识当前实际加载的版本。'], [
  ['The website checks for a new version about every five minutes while the page is open.', '页面打开时，网站约每五分钟检查一次新版本。'],
  ['GitHub keeps older guide revisions in the repository history.', 'GitHub 仓库历史保留旧版教程。']
]);
p('offline', 'support', 'Use a cached page with care', '使用缓存页面和处理离线状态', ['An earlier visit must have cached the page.', '需要此前访问已缓存页面。'], [
  ['If the network stops, read the page status.', '网络中断时，查看页面状态。'],
  ['Keep unsaved input on the open page.', '在已打开页面上保留未保存输入。'],
  ['Connect to the network before cloud reads, saves, uploads, or exports.', '云端读取、保存、上传或导出前，先恢复网络。'],
  ['Use the save-error procedure if a write fails.', '写入失败时，使用保存错误处理流程。']
], ['Cached page content can remain available without a confirmed cloud save.', '缓存页面内容可能仍可查看，但不能据此确认云端保存成功。'], [
  ['There is no guaranteed offline data queue or full offline database.', '目前没有保证可靠的离线数据队列或完整离线数据库。'],
  ['The guide can be cached with the website resources.', '教程可随网站资源一起缓存。']
]);
p('limits', 'support', 'Check available operations', '核对当前功能边界', ['Use the guide version that matches SciHub.', '使用与 SciHub 版本相符的教程。'], [
  ['Use only the controls that appear in your account.', '只使用账号中实际出现的控件。'],
  ['For older experiment logs, search "科研记录".', '较早实验日志可在“科研记录”中搜索。'],
  ['If an operation is unavailable, retain the original data.', '操作不可用时，保留原始数据。'],
  ['Give the maintainer the version and error text without passwords or private research content.', '向维护者提供版本和错误文字，不包含密码或私密科研内容。']
], ['You can report a problem and keep the original evidence.', '可以反馈问题，并保留原始证据。'], [
  ['This version has no password-reset page, team role approval, plan recycle bin, or completed-experiment reopen control.', '此版本没有密码找回页、团队角色审批、方案回收站或已完成实验重新编辑入口。'],
  ['There is no general list of all completed experiment details.', '目前没有列出全部已完成实验详情的通用历史列表。'],
  ['Laboratory work must follow your approved local procedures.', '实验室操作必须遵循本单位已批准的规程。']
]);
// Screenshots show local fictional examples. Numbers match the arrow labels.
function figure(id, file, width, height, caption, labels) {
  const item = procedures.find(item => item.id === id);
  (item.figures ||= []).push({ file: 'assets/guide/' + file + '.png', width, height,
    caption: pair(...caption), alt: pair(...caption), labels: labels.map(x => pair(...x)) });
}
figure('navigation', 'home', 1265, 865, ['Home page navigation', '主页导航与常用入口'], [
  ['Select the SciHub logo to return home.', '点击 SciHub 图标返回主页。'],
  ['Select "小工具" to open the calculator menu.', '点击“小工具”打开计算器菜单。'],
  ['Use the navigation bar to open home, plans, or records.', '通过导航栏切换主页、实验方案和科研记录。']
]);
figure('tools-menu', 'tools', 1265, 865, ['Select a calculator', '选择计算器'], [
  ['Select the solution calculator.', '选择配制溶液计算器。'],
  ['Select the platinum reagent calculator.', '选择铂氯酸计算器。'],
  ['Select the pyrolysis program calculator.', '选择热解程序计算器。']
]);
figure('solution-tool', 'solution', 1265, 865, ['Enter solution parameters', '填写配制溶液参数'], [
  ['Select the reagent and enter the target concentration in mol/L.', '选择试剂并输入目标浓度，单位为 mol/L。'],
  ['Enter the final volume and select mL or L.', '输入最终配制体积并选择 mL 或 L。'],
  ['Check the stock concentration and density against the bottle label or certificate.', '按瓶签或证书核对原液浓度和密度。']
]);
figure('solution-tool', 'solution-result', 1265, 865, ['Read the dilution result', '读取配制溶液结果'], [
  ['Read the required stock volume and mass.', '读取需加入原液的体积和质量。'],
  ['Check the stock molar concentration and final volume.', '核对原液摩尔浓度及最终配制体积。'],
  ['Add acid to water, allow cooling, then make up to the final volume.', '酸加入水中，冷却后定容至目标体积。']
]);
figure('plan-edit', 'plan', 1280, 875, ['Plan preview controls', '实验方案预览与操作'], [
  ['Check the steps, then select "开始实验".', '核对步骤后，点击“开始实验”。'],
  ['Select "编辑方案" to change the plan draft.', '点击“编辑方案”修改方案草稿。'],
  ['Select "返回方案列表" to read other plans.', '点击“返回方案列表”查看其他方案。']
]);
figure('run-data', 'run', 1265, 1301, ['Enter experiment measurements', '填写实验数据与备注'], [
  ['Enter actual measurements and check the field units.', '填写实际测量值，并核对字段单位。'],
  ['Enter actual operations and deviations in the notes.', '填写实际操作情况及偏差备注。'],
  ['After you complete the step, select "完成并下一步".', '完成当前步骤后，点击“完成并下一步”。']
]);
figure('run-resume', 'run-progress', 1265, 865, ['Recorded progress and step browsing', '实际记录进度与步骤浏览'], [
  ['The recorded progress is step 7 while the operator reads step 8.', '实际记录到第 7 步，当前浏览第 8 步。'],
  ['Leave unknown data empty; zero is a valid record.', '未填写的数据保持空白，零是有效记录。'],
  ['Select a step number to browse without advancing recorded progress.', '点击步骤编号只切换浏览，不增加已记录进度。']
]);
figure('merge-review', 'merge-review', 1265, 865, ['Review a merge after step 7', '审核第 7 步之后的合并'], [
  ['Select the boundary after step 7; the common stage starts at step 8.', '选择第 7 步之后混合，共同阶段从第 8 步开始。'],
  ['The review checks actual records; browsing empty steps does not advance progress.', '审核检查实际记录，浏览空白步骤不会增加进度。'],
  ['If selections or data change, select "审核合并条件" again.', '选择或数据改变后，点击“审核合并条件”重新审核。']
]);
figure('record-edit', 'record', 1265, 1343, ['Edit a research record', '编辑科研记录'], [
  ['Enter the record title.', '填写记录标题。'],
  ['Enter the record content.', '填写科研记录内容。'],
  ['Select "保存" and wait for the save confirmation.', '点击“保存”，等待保存成功提示。']
]);
module.exports = {
  version: '1.2.0', updated: '2026-10-10',
  standard: { name: 'ASD-STE100', issue: 9, reference: 'https://www.asd-ste100.org/STE_faq.html',
    status: pair('English procedures follow STE writing principles; full dictionary compliance has not been independently verified.',
      '英文流程采用 STE 写作原则；尚未完成完整词典符合性及独立审核。') },
  groups: [
    ['start', 'Start here', '开始使用'], ['account', 'Account', '账号'], ['home', 'Home and tasks', '主页与待办'],
    ['records', 'Research records', '科研记录'], ['plans', 'Experiment plans', '实验方案'], ['runs', 'Experiment work', '实验执行'],
    ['media', 'Photographs and videos', '照片与视频'], ['merge', 'Parallel experiment merge', '平行实验合并'],
    ['tools', 'Calculators', '计算工具'], ['support', 'Updates and help', '更新与故障处理']
  ].map(([id, en, zh]) => ({ id, title: pair(en, zh) })),
  glossary: [
    ['plan', '方案', 'A reusable definition of steps, fields, and conditions.', '可以复用的步骤、字段和条件定义。'],
    ['experiment', '一次实验', 'A saved execution of a plan with its own actual data.', '带独立实际数据的一次方案执行。'],
    ['step', '步骤', 'One operation within a plan or experiment.', '方案或实验中的一个操作。'],
    ['field', '字段', 'A named input for one value.', '用于填写一个值的命名输入。'],
    ['snapshot', '快照', 'A saved copy of a definition at a specific time.', '某一时点保存的定义副本。'],
    ['branch', '支路', 'An experiment with separate records before sample mixing.', '样品混合前分别记录的实验。'],
    ['common stage', '共同阶段', 'The single record set for operations after sample mixing.', '样品混合后操作所使用的唯一记录集合。'],
    ['mixing boundary', '混合边界', 'The last separate step before the common stage.', '共同阶段之前最后一个独立步骤。'],
    ['merge review', '合并审核', 'The definition and data checks before a merge.', '合并前进行的定义和数据检查。'],
    ['attachment', '附件', 'A photograph or video for a step.', '某一步附带的照片或视频。'],
    ['caption', '注解', 'Text that identifies or explains an attachment.', '用于标识或解释附件的文字。'],
    ['read-only', '只读', 'You can read the data but cannot edit it.', '可以查看数据，但不能编辑。'],
    ['pyrolysis program', '热解程序', 'Temperature and time instructions for the laboratory instrument.', '实验仪器的温度和时间指令。'],
    ['heating rate', '升温速率', 'The temperature increase per minute.', '每分钟的温度增加量。'],
    ['parser', '解析器', 'Software that converts plan text into step definitions.', '将方案文字转换为步骤定义的软件。'],
    ['CSV', 'CSV', 'A text file with comma-separated table values.', '以逗号分隔表格值的文本文件。'],
    ['Word document', 'Word 文档', 'A .docx file for a plan or exported record.', '用于方案或导出记录的 .docx 文件。'],
    ['cloud save', '云端保存', 'A successful write to the online data service.', '成功写入在线数据服务。']
  ].map(([en, zh, de, dz]) => ({ term: pair(en, zh), definition: pair(de, dz) })),
  procedures
};
