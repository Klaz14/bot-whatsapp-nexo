const fs = require('fs');

function createLogService(config) {
  function appendLog(filePath, line) {
    fs.appendFile(filePath, line + '\n', (err) => {
      if (err) console.error('No se pudo escribir', filePath, err.message);
    });
  }

  return {
    upload(line) {
      appendLog(config.paths.uploadsLog, line);
    },
    error(line) {
      appendLog(config.paths.errorsLog, line);
    },
  };
}

module.exports = {
  createLogService,
};
