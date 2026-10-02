import fs from "node:fs";
import path from "node:path";

const filePath = path.resolve(
    "node_modules/@diffusionstudio/vits-web/dist/vits-web.js"
);

if (!fs.existsSync(filePath)) {
    throw new Error(
        "找不到 vits-web.js: " + filePath
    );
}

let code = fs.readFileSync(
    filePath,
    "utf8"
);


// =========================================================
// 1. 限制 ONNX WASM Thread = 1
// =========================================================

if (
    !code.includes(
        "navigator.hardwareConcurrency"
    )
) {
    console.log(
        "numThreads 已修改或找不到原始設定"
    );
}
else {
    code = code.replace(
        /navigator\.hardwareConcurrency/g,
        "1"
    );

    console.log(
        "已將 numThreads 限制為 1"
    );
}


// =========================================================
// 2. 每次 inference 完成後 release session
// =========================================================

if (!code.includes("__vitsWavResult")) {

    const pattern =
        /const\s*\{\s*output\s*:\s*\{\s*data\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*\}\s*=\s*await\s*([A-Za-z_$][\w$]*)\.run\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;\s*return\s+new\s+Blob\(\s*\[\s*([A-Za-z_$][\w$]*)\(\s*\1\s*,\s*1\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\]\s*,\s*\{\s*type\s*:\s*["']audio\/x-wav["']\s*\}\s*\)/;

    const match =
        code.match(pattern);

    if (!match) {
        throw new Error(
            "找不到 vits-web inference 程式碼，無法加入 session.release()"
        );
    }

    const [
        fullMatch,
        pcm,
        session,
        feeds,
        pcm2wav,
        sampleRate
    ] = match;

    const replacement =
        `const{output:{data:${pcm}}}=await ${session}.run(${feeds});` +
        `const __vitsWavResult=new Blob([${pcm2wav}(${pcm},1,${sampleRate})],{type:"audio/x-wav"});` +
        `await ${session}.release();` +
        `return __vitsWavResult`;

    code = code.replace(
        fullMatch,
        replacement
    );

    console.log(
        "已加入 session.release()"
    );
}
else {
    console.log(
        "session.release patch 已存在"
    );
}


// =========================================================
// Save
// =========================================================

fs.writeFileSync(
    filePath,
    code,
    "utf8"
);

console.log(
    "vits-web memory patch 完成"
);
