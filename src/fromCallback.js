function resolver(fn, args, resolve, reject) {
  args.push((error, result) =>
    error != null ? reject(error) : resolve(result)
  );
  fn.apply(this, args);
}

// Usage:
//
//     fromCallback(fs.readFile, 'foo.txt')
//       .then(content => {
//         console.log(content)
//       })
module.exports = function fromCallback(fn, ...args) {
  return new Promise(resolver.bind(this, fn, args));
};
