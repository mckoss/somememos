# SomeMemos

A web server to serve a notebook-based web site (aka a file-based extensible CMS).

This software is **NOT** ready for human conumption.

# Installation (via pip)

    $ virtualenv env
    $ source env/bin/activate
    $ pip install webnotes

# Use development environment

    $ source bin/use

# Creating a new Notebook site

    $ webnotes create <dirname>

# Run Netbook site server

    $ webnotes run-server [dirname]

# Directory Structure

   bin - Development scripts.
   somememos - TheNote there are two places where "somememos" is used in this project.
   somememos/tests - Unit tests.
   env (not under source control - a local virtual env for development purposes)
   docs - Documentation

Don't be confused by two file objects with the "somememos" name:

   bin/somememos - A (python) script that implements the somememos command-line commands.
   somememos (directory) - The somememos (python) package implementing the core web server functionality.
