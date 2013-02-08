import os
import sys
import signal
import logging


class PidFile(object):
    """ A Context manager for pid file.

    Usage:

      with PidFile(file_path, callback):
          ...body of program...

    When the program terminates, the pid file will be removed automatically.
    """
    def __init__(self, file_path, on_exit=None, daemon=False, on_signal=None):
        if daemon:
            self._daemonize()

        self.file_path = file_path
        self.on_exit = on_exit
        if on_signal is None:
            self.on_signal = self.term_handler
        else:
            self.on_signal = on_signal
        signal.signal(signal.SIGTERM, self.on_signal)
        if os.path.isfile(file_path):
            with open(file_path) as pid_file:
                pid = pid_file.read()
                if self.is_pid_running(pid):
                    raise PidError("Duplicate pid file (%s) in use (pid = %s)." %
                                   (file_path, pid))
                else:
                    logging.warning("Abandoned pid file, %s - process inactive." % file_path)
        self.pid = os.getpid()
        with open(file_path, 'w') as f:
            f.write('%d\n' % self.pid)

        if daemon:
            self._disconnect_std_files()

    def term_handler(self, sig_num, frame):
        logging.critical("Process being killed.")
        raise SystemExit

    def __enter__(self):
        # Find home directory for logs so that know what's running.
        home = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
        logging.critical("Process startup (pid=%d, home=%s)." % (self.pid, home))
        return self

    def __exit__(self, exc_type=None, exc_value=None, traceback=None):
        if self.on_exit is not None:
            try:
                self.on_exit()
            except Exception, e:
                logging.error("Exception in exit function for %s (%s).", self.file_path, e)
        logging.critical("Process terminating (pid=%d)." % self.pid)
        os.remove(self.file_path)
        # Suppress error message for keyboard interrupt.
        if exc_type == KeyboardInterrupt:
            return True

    @staticmethod
    def is_pid_running(pid):
        try:
            pid = int(pid)
            os.kill(pid, 0)
        except (OSError, ValueError):
            return False
        return True

    def _daemonize(self):
        # TODO: os.chdir to good place?

        # Double fork as described in the Stevens book.
        pid = os.fork()
        if pid > 0:
            sys.exit(0)
        os.setsid()
        os.umask(0)
        pid = os.fork()
        if pid > 0:
            sys.exit(0)

        # Restart loop.
        start_window = time.time() + 10.0
        retry_count = 0
        while True:
            pid = os.fork()
            if pid <= 0:
                # Child process.
                break

            self._disconnect_std_files()
            p, code = self._waitpid(pid, 0)

            if os.WIFSIGNALED(code):
                c = os.WTERMSIG(code)
                reason = 'signal %d' % c
                exit = c in (9, 15)
            elif os.WIFEXITED(code):
                c = os.WEXITSTATUS(code)
                reason = 'status %d' % c
                exit = c == 0
            else:
                reason = 'value %d' % code
                exit = False

            retry_count += 2
            if not exit and time.time() < start_window and retry_count >= 2:
                reason = '%s after %d tries' % (reason, retry_count)
                exit = True

            if exit:
                logging.info("Process %d exited with %s. Exiting.", p, reason)
                sys.exit(0)

            logging.info("Process %d exited with %s. Restarting.", p, reason)
            time.sleep(0.3)  # avoid spinning

    def _disconnect_std_files(self):
        fdn = os.open("/dev/null", os.O_WRONLY | os.O_CREAT)
        for fd in (0, 1, 2):
            os.dup2(fdn, fd)
        os.close(fdn)

    def _waitpid(self, pid, options):
        """os.waitpid with retry on EINTR."""
        while True:
            try:
                return os.waitpid(pid, options)
            except OSError, e:
                if e.errno == errno.EINTR:
                    continue
                else:
                    raise


class PidError(Exception):
    pass
