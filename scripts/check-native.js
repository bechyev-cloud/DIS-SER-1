// Проверяет, что модуль базы данных собран под текущую версию Node.
// Если нет (например, хостинг взял старую сборку из кэша) — пересобирает его сам.
const { execSync } = require('child_process');
const path = require('path');

function works() {
  const out = execSync(
    `"${process.execPath}" -e "const D=require('better-sqlite3');new D(':memory:').close()"`,
    { cwd: path.join(__dirname, '..'), stdio: 'pipe' }
  );
  return out !== null;
}

try {
  works();
} catch (e) {
  console.log('[check-native] better-sqlite3 не подходит к этой версии Node — пересобираю…');
  try {
    execSync('npm rebuild better-sqlite3', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    works();
    console.log('[check-native] готово.');
  } catch (e2) {
    console.error('[check-native] не удалось пересобрать better-sqlite3:', e2.message);
    process.exit(1);
  }
}
