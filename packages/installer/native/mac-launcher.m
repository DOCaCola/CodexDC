#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <unistd.h>

int main(int argc, char **argv) {
  @autoreleasepool {
    NSBundle *bundle = [NSBundle mainBundle];
    NSError *error = nil;
    NSString *metadataPath = [[bundle resourcePath] stringByAppendingPathComponent:@"codexdc-launch.json"];
    NSData *metadata = [NSData dataWithContentsOfFile:metadataPath];
    NSDictionary *launch = metadata ? [NSJSONSerialization JSONObjectWithData:metadata options:0 error:&error] : nil;
    NSString *backendPath = launch[@"backendFile"];
    NSString *originalName = launch[@"originalExecutable"];
    if (!backendPath || !originalName) error = [NSError errorWithDomain:@"CodexDC" code:1 userInfo:@{NSLocalizedDescriptionKey: @"CodexDC launch metadata is missing. Run Repair."}];
    unsetenv("CODEX_CLI_PATH");
    if (!error && [[NSFileManager defaultManager] fileExistsAtPath:backendPath]) {
      NSDictionary *backend = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:backendPath] options:0 error:&error];
      if ([backend[@"provider"] isEqual:@"fork"]) {
        NSString *cli = backend[@"installed"][@"executable"];
        if (!cli || ![[NSFileManager defaultManager] isExecutableFileAtPath:cli]) {
          error = [NSError errorWithDomain:@"CodexDC" code:2 userInfo:@{NSLocalizedDescriptionKey: @"The selected fork CLI is missing. Open CodexDC Setup to reinstall it or select Desktop bundled."}];
        } else setenv("CODEX_CLI_PATH", [cli fileSystemRepresentation], 1);
      } else if (![backend[@"provider"] isEqual:@"bundled"]) {
        error = [NSError errorWithDomain:@"CodexDC" code:3 userInfo:@{NSLocalizedDescriptionKey: @"Invalid CLI backend setting."}];
      }
    }
    if (error) {
      NSAlert *alert = [[NSAlert alloc] init];
      alert.messageText = @"CodexDC could not start";
      alert.informativeText = error.localizedDescription;
      [alert runModal];
      return 1;
    }
    NSString *executable = [[[bundle executablePath] stringByDeletingLastPathComponent] stringByAppendingPathComponent:originalName];
    argv[0] = (char *)[executable fileSystemRepresentation];
    execv(argv[0], argv);
    return 1;
  }
}
