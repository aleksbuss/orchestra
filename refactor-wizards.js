const fs = require('fs');
const file = 'src/components/settings/model-wizards.tsx';
let txt = fs.readFileSync(file, 'utf8');

// Replace the function signature
txt = txt.replace(
  `export function ChatModelWizard({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: UpdateSettingsFn;
}) {
  const provider = settings.chatModel.provider;
  const apiKey = settings.chatModel.apiKey || "";
  const model = settings.chatModel.model;`,
  `export function ModelConfigWizard({
  settings,
  updateSettings,
  configKey,
  title = "Model Configuration",
}: {
  settings: AppSettings;
  updateSettings: UpdateSettingsFn;
  configKey: "chatModel" | "utilityModel";
  title?: string;
}) {
  const config = settings[configKey];
  const provider = config.provider;
  const apiKey = config.apiKey || "";
  const model = config.model;`
);

// We need to replace all `settings.chatModel.xxxx` to `config.xxxx` within the wizard
// But wait, there are updateSettings("chatModel.authMethod", ...) inside, which need to be \`${configKey}.authMethod\`

// A precise way: only replace between ModelConfigWizard and EmbeddingsModelWizard.
const startIdx = txt.indexOf('export function ModelConfigWizard');
const endIdx = txt.indexOf('export function EmbeddingsModelWizard');

let wizardBody = txt.substring(startIdx, endIdx);

wizardBody = wizardBody.replace(/settings\.chatModel/g, 'config');
wizardBody = wizardBody.replace(/"chatModel\.([a-zA-Z]+)"/g, '`${configKey}.$1`');
wizardBody = wizardBody.replace(/<h3 className="font-semibold text-lg">Chat Model<\/h3>/g, '<h3 className="font-semibold text-lg">{title}</h3>');

txt = txt.substring(0, startIdx) + wizardBody + txt.substring(endIdx);

// Append the specialized exports at the end or before EmbeddingsModelWizard
const exportsStr = `
export function ChatModelWizard({ settings, updateSettings }: { settings: AppSettings; updateSettings: UpdateSettingsFn; }) {
  return <ModelConfigWizard settings={settings} updateSettings={updateSettings} configKey="chatModel" title="Chat Model (Orchestrator / Brain)" />;
}

export function UtilityModelWizard({ settings, updateSettings }: { settings: AppSettings; updateSettings: UpdateSettingsFn; }) {
  return <ModelConfigWizard settings={settings} updateSettings={updateSettings} configKey="utilityModel" title="Swarm Worker Model (Background & Agents)" />;
}

`;

txt = txt.replace('export function EmbeddingsModelWizard', exportsStr + 'export function EmbeddingsModelWizard');

fs.writeFileSync(file, txt);
console.log("Refactoring complete");
