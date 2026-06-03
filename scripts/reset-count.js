const db = require("./db");
db.prepare("UPDATE counter SET visits = 0 WHERE id = 1").run();
console.log("Counter reset to 0");
