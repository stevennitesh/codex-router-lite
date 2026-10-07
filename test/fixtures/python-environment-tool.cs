using System;
using System.IO;
using System.Reflection;

// A fixture executable stands in for uv, py and venv Python. It never imports
// packages or accesses a network. The shipped PowerShell installer supplies
// its real arguments; tests assert those observed calls.
public static class PythonEnvironmentTool {
  public static int Main(string[] arguments) {
    var uv = arguments.Length > 0 && arguments[0] == "--fixture-uv";
    if (uv) {
      var rest = new string[arguments.Length - 1];
      Array.Copy(arguments, 1, rest, 0, rest.Length);
      arguments = rest;
    }
    var executable = Assembly.GetExecutingAssembly().Location;
    File.AppendAllText(Environment.GetEnvironmentVariable("ROUTER_INSTALL_TRACE"),
      (uv ? "uv" : "python") + "\t" + string.Join("\t", arguments) + "\n");
    var venv = uv && arguments.Length > 0 && arguments[0] == "venv";
    for (var index = 0; index + 1 < arguments.Length; index++) {
      if (arguments[index] == "-m" && arguments[index + 1] == "venv") venv = true;
    }
    if (venv) {
      var root = arguments[arguments.Length - 1];
      if (Array.IndexOf(arguments, "--clear") >= 0 && Directory.Exists(root)) Directory.Delete(root, true);
      var scripts = Path.Combine(root, "Scripts");
      Directory.CreateDirectory(scripts);
      File.Copy(executable, Path.Combine(scripts, "python.exe"), true);
      File.WriteAllText(Path.Combine(root, "pyvenv.cfg"),
        "home = " + Path.GetDirectoryName(root) + "\nversion = 3.12.12\n");
    }
    var install = Array.IndexOf(arguments, "--require-hashes") >= 0;
    if (install) {
      if (Environment.GetEnvironmentVariable("ROUTER_FAIL_DEPENDENCY_INSTALL") == "1") return 9;
      var root = uv ? Path.GetDirectoryName(Path.GetDirectoryName(arguments[Array.IndexOf(arguments, "--python") + 1]))
        : Path.GetDirectoryName(Path.GetDirectoryName(executable));
      var packages = Path.Combine(root, "Lib", "site-packages");
      foreach (var line in File.ReadAllLines(Path.Combine(Environment.CurrentDirectory, "requirements", "python.in"))) {
        if (line.StartsWith("#") || line.Trim().Length == 0) continue;
        var parts = line.Split(new string[] { "==" }, StringSplitOptions.None);
        var name = parts[0].Split('[')[0];
        Directory.CreateDirectory(Path.Combine(packages, name + "-" + parts[1] + ".dist-info"));
      }
    }
    if (Array.IndexOf(arguments, "-c") >= 0) {
      if (File.Exists(Path.Combine(Path.GetDirectoryName(executable), "broken.txt"))) return 7;
      Console.WriteLine(Path.GetDirectoryName(Path.GetDirectoryName(executable)));
    }
    return 0;
  }
}
