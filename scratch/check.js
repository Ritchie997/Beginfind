const sample = "```javascript\nconst x = 10;\nfunction test() { return x * 2; }\n```";
const regex = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/g;
console.log('Regex test:', regex.test(sample));
