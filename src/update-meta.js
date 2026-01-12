const fs = require('fs');
const path = require('path');

const indexPath = path.resolve(__dirname, '..', 'public', 'index.html');
let content = fs.readFileSync(indexPath, 'utf8');

const ogTags = `
    <meta property="og:title" content="MapleSight" />
    <meta property="og:description" content="A companion for MapleStory that collects information from your screen." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://SyouSB.github.io/MapleSight">
`;

if (!content.includes('og:title')) {
    content = content.replace('</head>', ogTags + '\n  </head>');
}

fs.writeFileSync(indexPath, content);
console.log('Successfully updated index.html with OG tags');
