#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <unistd.h>

int main(int argc, char **argv) {
  @autoreleasepool {
    NSBundle *bundle = [NSBundle mainBundle];
    NSError *error = nil;
    NSData *metadata = [NSData dataWithContentsOfFile:[[bundle resourcePath] stringByAppendingPathComponent:@"codexdc-launch.json"]];
    NSDictionary *launch = metadata ? [NSJSONSerialization JSONObjectWithData:metadata options:0 error:&error] : nil;
    NSString *node = launch[@"maintenanceNode"];
    NSString *cli = launch[@"maintenanceCli"];
    NSString *root = launch[@"userRoot"];
    if (!node || !cli || !root || ![[NSFileManager defaultManager] isExecutableFileAtPath:node] ||
        ![[NSFileManager defaultManager] fileExistsAtPath:cli]) {
      error = [NSError errorWithDomain:@"CodexDC" code:1 userInfo:@{NSLocalizedDescriptionKey: @"The CodexDC maintenance package is missing. Run Setup to repair the installation."}];
    }
    if (!error) {
      NSMutableArray *arguments = [NSMutableArray array];
      for (int i = 1; i < argc; i++) [arguments addObject:[NSString stringWithUTF8String:argv[i]]];
      NSData *json = [NSJSONSerialization dataWithJSONObject:arguments options:0 error:&error];
      if (!error) {
        NSString *encoded = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        setenv("CODEXDC_DESKTOP_ARGS", [encoded UTF8String], 1);
        setenv("CODEXDC_HOME", [root fileSystemRepresentation], 1);
        char *args[] = {(char *)[node fileSystemRepresentation], (char *)[cli fileSystemRepresentation], "launch", NULL};
        // Replace the wrapper before maintenance runs, so no app executable is
        // held open while the managed copy is refreshed. Node starts the real app.
        execv(args[0], args);
        error = [NSError errorWithDomain:@"CodexDC" code:2 userInfo:@{NSLocalizedDescriptionKey: @"Could not start CodexDC maintenance. Run Setup."}];
      }
    }
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"CodexDC could not start";
    alert.informativeText = error.localizedDescription;
    [alert runModal];
    return 1;
  }
}
